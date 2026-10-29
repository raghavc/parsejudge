import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { acquire, EMPTY_POOL, expire, nextExpiry, nextWaiter, type PoolState, promote, release, type Waiter } from "./pool.ts";

const RETRY_WAKE_MS = 5000;

/**
 * Counting semaphore for one pool (a provider API key, or the judge). One instance per pool.
 * Slots are leases with an expiry, so a slot held by a workflow that died frees itself.
 * A waiter is woken by `sendEvent` on its PageWorkflow instance; nothing polls.
 */
export class ProviderSlots extends DurableObject<Env> {
  /** Every change runs here one at a time, so a change that awaits a wake-up never overwrites another. */
  private tail: Promise<unknown> = Promise.resolve();

  private serial<A>(change: () => Promise<A>): Promise<A> {
    const result = this.tail.then(change);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Returns true when the slot is held now. Otherwise the waiter is queued and gets its event later. */
  acquire(limit: number, waiter: Waiter): Promise<boolean> {
    return this.serial(async () => {
      await this.ctx.storage.put("limit", limit);
      const result = acquire(await this.load(), limit, waiter, Date.now());
      await this.save(result.state);
      return result.granted;
    });
  }

  /** Frees a held or queued lease and wakes waiters into the freed slots. Idempotent. */
  release(lease: string): Promise<void> {
    return this.serial(async () => this.wake(release(await this.load(), lease)));
  }

  override alarm(): Promise<void> {
    return this.serial(async () => this.wake(expire(await this.load(), Date.now())));
  }

  /** Moves waiters into every free slot, saves, then sends their events in parallel. */
  private async wake(initial: PoolState): Promise<void> {
    const limit = (await this.ctx.storage.get<number>("limit")) ?? 0;
    let state = initial;
    for (;;) {
      const woken: Array<Waiter> = [];
      for (let next = nextWaiter(state, limit); next !== undefined; next = nextWaiter(state, limit)) {
        woken.push(next);
        state = promote(state, Date.now());
      }
      if (woken.length === 0) return this.save(state);
      await this.save(state);
      const sent = await Promise.allSettled(
        woken.map(async (w) => this.env.PAGE_WORKFLOW.get(w.instanceId).then((i) => i.sendEvent({ type: w.event, payload: {} }))),
      );
      const failed = woken.filter((_, i) => sent[i]?.status === "rejected");
      if (failed.length === 0) return;
      const gone = await Promise.all(failed.map((w) => this.finished(w.instanceId)));
      // A waiter whose workflow ended gives its slot back; one still alive goes back to the head of the queue.
      const retry = failed.filter((_, i) => !gone[i]);
      state = failed.reduce((acc, w) => release(acc, w.lease), state);
      state = { ...state, queue: [...retry, ...state.queue] };
      if (retry.length > 0) return this.save(state, Date.now() + RETRY_WAKE_MS);
    }
  }

  private async finished(instanceId: string): Promise<boolean> {
    try {
      const { status } = await (await this.env.PAGE_WORKFLOW.get(instanceId)).status();
      return status === "complete" || status === "errored" || status === "terminated";
    } catch {
      return true;
    }
  }

  private async load(): Promise<PoolState> {
    return (await this.ctx.storage.get<PoolState>("pool")) ?? EMPTY_POOL;
  }

  private async save(state: PoolState, retryAt?: number): Promise<void> {
    await this.ctx.storage.put("pool", state);
    const alarm = [nextExpiry(state), retryAt].filter((t): t is number => t !== undefined);
    if (alarm.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...alarm));
  }
}
