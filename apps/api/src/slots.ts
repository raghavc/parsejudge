import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";
import {
  acquire,
  dropHead,
  EMPTY_POOL,
  expire,
  nextExpiry,
  nextWaiter,
  type PoolState,
  promote,
  release,
  type Waiter,
} from "./pool.ts";

const RETRY_WAKE_MS = 5000;

/**
 * Counting semaphore for one pool (a provider API key, or the judge). One instance per pool.
 * Slots are leases with an expiry, so a slot held by a workflow that died frees itself.
 * A waiter is woken by `sendEvent` on its PageWorkflow instance; nothing polls.
 */
export class ProviderSlots extends DurableObject<Env> {
  /** Returns true when the slot is held now. Otherwise the waiter is queued and gets its event later. */
  async acquire(limit: number, waiter: Waiter): Promise<boolean> {
    await this.ctx.storage.put("limit", limit);
    const result = acquire(await this.load(), limit, waiter, Date.now());
    await this.save(result.state);
    return result.granted;
  }

  /** Frees a held or queued lease and wakes waiters into the freed slots. Idempotent. */
  async release(lease: string): Promise<void> {
    await this.wake(release(await this.load(), lease));
  }

  override async alarm(): Promise<void> {
    await this.wake(expire(await this.load(), Date.now()));
  }

  private async wake(initial: PoolState): Promise<void> {
    const limit = (await this.ctx.storage.get<number>("limit")) ?? 0;
    let state = initial;
    for (let next = nextWaiter(state, limit); next !== undefined; next = nextWaiter(state, limit)) {
      try {
        await (await this.env.PAGE_WORKFLOW.get(next.instanceId)).sendEvent({ type: next.event, payload: {} });
        state = promote(state, Date.now());
      } catch (error) {
        if (!(await this.finished(next.instanceId))) {
          await this.save(state, Date.now() + RETRY_WAKE_MS);
          throw error;
        }
        state = dropHead(state);
      }
    }
    await this.save(state);
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
