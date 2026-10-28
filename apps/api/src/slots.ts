import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

/** A queued request for a slot. The holder is woken by an event on its workflow instance. */
export interface Waiter {
  readonly lease: string;
  readonly instanceId: string;
  readonly event: string;
}

const LEASE_MS = 60 * 60 * 1000;
const RETRY_GRANT_MS = 5000;

/**
 * Counting semaphore for one pool (a provider API key, or the judge). One instance per pool.
 * Slots are leases with an expiry, so a slot held by a workflow that died frees itself.
 * A waiter is woken by `sendEvent` on its PageWorkflow instance; nothing polls.
 */
export class ProviderSlots extends DurableObject<Env> {
  /** Returns true when the slot is held now. Otherwise the waiter is queued and gets an event later. */
  async acquire(limit: number, waiter: Waiter): Promise<boolean> {
    await this.ctx.storage.put("limit", limit);
    const holders = await this.holders();
    if (holders.has(waiter.lease)) return true;
    const queue = await this.queue();
    if (holders.size < limit && queue.length === 0) {
      holders.set(waiter.lease, Date.now() + LEASE_MS);
      await this.save(holders, queue);
      return true;
    }
    if (!queue.some((queued) => queued.lease === waiter.lease)) queue.push(waiter);
    await this.save(holders, queue);
    return false;
  }

  /** Frees a held or queued lease and grants freed slots in FIFO order. Idempotent. */
  async release(lease: string): Promise<void> {
    const holders = await this.holders();
    holders.delete(lease);
    await this.grant(
      holders,
      (await this.queue()).filter((queued) => queued.lease !== lease),
    );
  }

  override async alarm(): Promise<void> {
    const holders = await this.holders();
    const now = Date.now();
    for (const [lease, expiresAt] of holders) if (expiresAt <= now) holders.delete(lease);
    await this.grant(holders, await this.queue());
  }

  private async grant(holders: Map<string, number>, queue: Array<Waiter>): Promise<void> {
    const limit = (await this.ctx.storage.get<number>("limit")) ?? 0;
    let retry = false;
    while (holders.size < limit && queue.length > 0) {
      const next = queue[0] as Waiter;
      try {
        await (await this.env.PAGE_WORKFLOW.get(next.instanceId)).sendEvent({ type: next.event, payload: {} });
        holders.set(next.lease, Date.now() + LEASE_MS);
        queue.shift();
      } catch (error) {
        if (await this.instanceGone(next.instanceId, error)) queue.shift();
        else {
          retry = true;
          break;
        }
      }
    }
    await this.save(holders, queue, retry);
  }

  private async instanceGone(instanceId: string, error: unknown): Promise<boolean> {
    try {
      const { status } = await (await this.env.PAGE_WORKFLOW.get(instanceId)).status();
      return status === "complete" || status === "errored" || status === "terminated";
    } catch {
      return String(error).includes("not_found");
    }
  }

  private async holders(): Promise<Map<string, number>> {
    return new Map(Object.entries((await this.ctx.storage.get<Record<string, number>>("holders")) ?? {}));
  }

  private async queue(): Promise<Array<Waiter>> {
    return (await this.ctx.storage.get<Array<Waiter>>("queue")) ?? [];
  }

  private async save(holders: Map<string, number>, queue: Array<Waiter>, retrySoon = false): Promise<void> {
    await this.ctx.storage.put({ holders: Object.fromEntries(holders), queue });
    const expiries = [...holders.values()];
    if (retrySoon) expiries.push(Date.now() + RETRY_GRANT_MS);
    if (expiries.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...expiries));
  }
}
