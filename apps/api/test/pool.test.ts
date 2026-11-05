import { describe, expect, it } from "vitest";
import { acquire, EMPTY_POOL, expire, LEASE_MS, nextWaiter, type PoolState, promote, release } from "../src/pool.ts";

const waiter = (lease: string) => ({ lease, instanceId: `wf-${lease}`, event: `slot-${lease}` });

const fill = (limit: number, leases: ReadonlyArray<string>) =>
  leases.reduce<{ state: PoolState; granted: Array<string> }>(
    ({ state, granted }, lease) => {
      const result = acquire(state, limit, waiter(lease), 0);
      return { state: result.state, granted: result.granted ? [...granted, lease] : granted };
    },
    { state: EMPTY_POOL, granted: [] },
  );

describe("concurrency pool", () => {
  it("grants up to the limit and queues the rest in order", () => {
    const { state, granted } = fill(2, ["a", "b", "c", "d"]);
    expect(granted).toEqual(["a", "b"]);
    expect(state.queue.map((w) => w.lease)).toEqual(["c", "d"]);
    expect(nextWaiter(state, 2)).toBeUndefined();
  });

  it("is idempotent for a retried acquire", () => {
    const { state } = fill(1, ["a", "b"]);
    expect(acquire(state, 1, waiter("a"), 0).granted).toBe(true);
    expect(acquire(state, 1, waiter("b"), 0).state.queue).toHaveLength(1);
  });

  it("hands a released slot to the head of the queue, not to a newcomer", () => {
    const freed = release(fill(1, ["a", "b"]).state, "a");
    expect(nextWaiter(freed, 1)?.lease).toBe("b");
    expect(acquire(freed, 1, waiter("c"), 0).granted).toBe(false);
    const woken = promote(freed, 0);
    expect(Object.keys(woken.holders)).toEqual(["b"]);
    expect(woken.queue).toHaveLength(0);
  });

  it("drops a queued lease on release", () => {
    expect(release(fill(1, ["a", "b"]).state, "b").queue).toHaveLength(0);
  });

  it("frees leases whose holder never released them", () => {
    const { state } = fill(1, ["a", "b"]);
    expect(nextWaiter(expire(state, LEASE_MS - 1), 1)).toBeUndefined();
    expect(nextWaiter(expire(state, LEASE_MS), 1)?.lease).toBe("b");
  });
});
