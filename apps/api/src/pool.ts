/** State of one concurrency pool: leases that hold a slot, and waiters in FIFO order. Pure, so it is easy to test. */
export interface Waiter {
  readonly lease: string;
  readonly instanceId: string;
  readonly event: string;
}

export interface PoolState {
  /** Lease id to expiry time in ms. */
  readonly holders: Readonly<Record<string, number>>;
  readonly queue: ReadonlyArray<Waiter>;
}

export const LEASE_MS = 60 * 60 * 1000;
export const EMPTY_POOL: PoolState = { holders: {}, queue: [] };

const held = (state: PoolState) => Object.keys(state.holders).length;

/** Takes a slot when one is free and nobody is ahead in the queue; otherwise queues the waiter once. */
export const acquire = (state: PoolState, limit: number, waiter: Waiter, now: number) => {
  if (state.holders[waiter.lease] !== undefined) return { granted: true, state };
  if (held(state) < limit && state.queue.length === 0) {
    return { granted: true, state: { ...state, holders: { ...state.holders, [waiter.lease]: now + LEASE_MS } } };
  }
  const queued = state.queue.some((w) => w.lease === waiter.lease);
  return { granted: false, state: queued ? state : { ...state, queue: [...state.queue, waiter] } };
};

/** Drops a lease, whether it holds a slot or is still queued. */
export const release = (state: PoolState, lease: string): PoolState => {
  const { [lease]: _, ...holders } = state.holders;
  return { holders, queue: state.queue.filter((w) => w.lease !== lease) };
};

export const expire = (state: PoolState, now: number): PoolState => ({
  ...state,
  holders: Object.fromEntries(Object.entries(state.holders).filter(([, expiresAt]) => expiresAt > now)),
});

/** The waiter to wake next, if a slot is free. */
export const nextWaiter = (state: PoolState, limit: number): Waiter | undefined =>
  held(state) < limit ? state.queue[0] : undefined;

/** Moves the head of the queue into the holders, after it was woken. */
export const promote = (state: PoolState, now: number): PoolState => {
  const [head, ...queue] = state.queue;
  return head === undefined ? state : { holders: { ...state.holders, [head.lease]: now + LEASE_MS }, queue };
};

/** Drops the head of the queue, when its workflow no longer exists. */

export const nextExpiry = (state: PoolState): number | undefined => {
  const expiries = Object.values(state.holders);
  return expiries.length === 0 ? undefined : Math.min(...expiries);
};
