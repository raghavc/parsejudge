import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Semaphore } from "effect";
import type { Env } from "./env.ts";
import { storage } from "./errors.ts";
import { acquire, EMPTY_POOL, expire, nextExpiry, nextWaiter, type PoolState, promote, release, type Waiter } from "./pool.ts";

/**
 * Counting semaphore for one pool (a provider API key, or the judge). One instance per pool.
 * Slots are leases with an expiry, so a slot held by a workflow that died frees itself.
 * A waiter is woken by `sendEvent` on its PageWorkflow instance, and asks again if the event does not come.
 */
export class ProviderSlots extends DurableObject<Env> {
  /** Every change to the pool state runs under this lock, one at a time. Wake-ups are sent outside it. */
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
    return this.change((state) => release(state, lease));
  }

  override alarm(): Promise<void> {
    return this.change((state) => expire(state, Date.now()));
  }

  /**
   * Applies `next` and hands free slots to waiters under the lock, then wakes them outside it: a slow
   * `sendEvent` must not hold up every other acquire and release. A waiter that misses its event still
   * holds the slot, and its page finds that out the next time it asks (see `PageWorkflow.withSlot`).
   */
  private change(next: (state: PoolState) => PoolState): Promise<void> {
    return Effect.runPromise(
      Effect.promise(() => this.serial(this.load().pipe(Effect.flatMap((state) => this.promoteAll(next(state)))))).pipe(
        Effect.flatMap((woken) =>
          Effect.sync(() => {
            if (woken.length > 0) this.ctx.waitUntil(Effect.runPromise(this.wake(woken)));
          }),
        ),
      ),
    );
  }

  /** Moves waiters into every free slot and saves. Returns the waiters to wake. */
  private promoteAll(initial: PoolState) {
    return Effect.gen({ self: this }, function* () {
      const limit = (yield* Effect.promise(() => this.ctx.storage.get<number>("limit"))) ?? 0;
      let state = initial;
      const woken: Array<Waiter> = [];
      for (let next = nextWaiter(state, limit); next !== undefined; next = nextWaiter(state, limit)) {
        woken.push(next);
        state = promote(state, Date.now());
      }
      yield* this.save(state);
      return woken;
    });
  }

  /** Sends wake-ups in parallel. A waiter whose workflow ended gives its slot back, which wakes the next one. */
  private wake(woken: ReadonlyArray<Waiter>): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
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
      const leases = failed.filter((_, i) => gone[i]).map((w) => w.lease);
      if (leases.length === 0) return;
      const next = yield* Effect.promise(() =>
        this.serial(this.load().pipe(Effect.flatMap((state) => this.promoteAll(leases.reduce(release, state))))),
      );
      if (next.length > 0) yield* this.wake(next);
    });
  }

  /** Whether the workflow has ended. A status that cannot be read counts as alive, so the waiter keeps its slot. */
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

  private save(state: PoolState) {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.promise(() => this.ctx.storage.put("pool", state));
      const alarm = nextExpiry(state);
      if (alarm === undefined) yield* Effect.promise(() => this.ctx.storage.deleteAlarm());
      else yield* Effect.promise(() => this.ctx.storage.setAlarm(alarm));
    });
  }
}
