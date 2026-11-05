import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Semaphore } from "effect";
import type { Env } from "./env.ts";
import { storage } from "./errors.ts";
import { acquire, EMPTY_POOL, expire, nextExpiry, nextWaiter, type PoolState, promote, release, type Waiter } from "./pool.ts";

const RETRY_WAKE_MS = 5000;

/**
 * Counting semaphore for one pool (a provider API key, or the judge). One instance per pool.
 * Slots are leases with an expiry, so a slot held by a workflow that died frees itself.
 * A waiter is woken by `sendEvent` on its PageWorkflow instance; nothing polls.
 */
export class ProviderSlots extends DurableObject<Env> {
  /** Every change runs under this lock one at a time, so a change that awaits a wake-up never overwrites another. */
  private readonly lock = Semaphore.makeUnsafe(1);

  private serial<A>(change: Effect.Effect<A>): Promise<A> {
    return Effect.runPromise(this.lock.withPermits(1)(change));
  }

  /** Returns true when the slot is held now. Otherwise the waiter is queued and gets its event later. */
  acquire(limit: number, waiter: Waiter): Promise<boolean> {
    return this.serial(
      Effect.gen({ self: this }, function* () {
        yield* Effect.promise(() => this.ctx.storage.put("limit", limit));
        const result = acquire(yield* this.load(), limit, waiter, Date.now());
        yield* this.save(result.state);
        return result.granted;
      }),
    );
  }

  /** Frees a held or queued lease and wakes waiters into the freed slots. Idempotent. */
  release(lease: string): Promise<void> {
    return this.serial(this.load().pipe(Effect.flatMap((state) => this.wake(release(state, lease)))));
  }

  override alarm(): Promise<void> {
    return this.serial(this.load().pipe(Effect.flatMap((state) => this.wake(expire(state, Date.now())))));
  }

  /** Moves waiters into every free slot, saves, then sends their events in parallel. */
  private wake(initial: PoolState) {
    return Effect.gen({ self: this }, function* () {
      const limit = (yield* Effect.promise(() => this.ctx.storage.get<number>("limit"))) ?? 0;
      let state = initial;
      for (;;) {
        const woken: Array<Waiter> = [];
        for (let next = nextWaiter(state, limit); next !== undefined; next = nextWaiter(state, limit)) {
          woken.push(next);
          state = promote(state, Date.now());
        }
        if (woken.length === 0) return yield* this.save(state);
        yield* this.save(state);
        const sent = yield* Effect.forEach(
          woken,
          (w) =>
            storage(() => this.env.PAGE_WORKFLOW.get(w.instanceId)).pipe(
              Effect.flatMap((i) => storage(() => i.sendEvent({ type: w.event, payload: {} }))),
              Effect.exit,
            ),
          { concurrency: "unbounded" },
        );
        const failed = woken.filter((_, i) => sent[i] !== undefined && Exit.isFailure(sent[i]));
        if (failed.length === 0) return;
        yield* Effect.forEach(failed, (w) => Effect.logWarning("Slot wake-up failed", w.instanceId, w.event));
        const gone = yield* Effect.forEach(failed, (w) => this.finished(w.instanceId), { concurrency: "unbounded" });
        // A waiter whose workflow ended gives its slot back; one still alive goes back to the head of the queue.
        const retry = failed.filter((_, i) => !gone[i]);
        state = failed.reduce((acc, w) => release(acc, w.lease), state);
        state = { ...state, queue: [...retry, ...state.queue] };
        if (retry.length > 0) return yield* this.save(state, Date.now() + RETRY_WAKE_MS);
      }
    });
  }

  /** Whether the workflow has ended. A status that cannot be read counts as alive, so the waiter is retried, not dropped. */
  private finished(instanceId: string) {
    return storage(() => this.env.PAGE_WORKFLOW.get(instanceId)).pipe(
      Effect.flatMap((instance) => storage(() => instance.status())),
      Effect.map(({ status }) => status === "complete" || status === "errored" || status === "terminated"),
      Effect.catch((error) =>
        Effect.logWarning("Slot waiter status unreadable", instanceId, error.message).pipe(Effect.as(false)),
      ),
    );
  }

  private load() {
    return Effect.promise(() => this.ctx.storage.get<PoolState>("pool")).pipe(Effect.map((pool) => pool ?? EMPTY_POOL));
  }

  private save(state: PoolState, retryAt?: number) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => this.ctx.storage.put("pool", state));
      const alarm = [nextExpiry(state), retryAt].filter((t): t is number => t !== undefined);
      if (alarm.length === 0) yield* Effect.promise(() => this.ctx.storage.deleteAlarm());
      else yield* Effect.promise(() => this.ctx.storage.setAlarm(Math.min(...alarm)));
    });
  }
}
