/** Polls 1 s apart at the start, so a typical job is seen within 1 s of finishing. */
const FAST_POLLS = 30;

/** Delay before poll `attempt`: 1 s for the first 30 s, then growing 1.5x, capped at 10 s. */
export const pollDelayMs = (attempt: number): number =>
  Math.round(Math.min(1000 * 1.5 ** Math.max(0, attempt - FAST_POLLS + 1), 10_000));

/** Longest a vendor job may run before the parse counts as timed out. */
export const POLL_BUDGET_MS = 30 * 60 * 1000;

/** Polls that fit in `POLL_BUDGET_MS`. Each poll costs two workflow steps (sleep, poll). */
export const MAX_POLLS = ((): number => {
  let attempts = 0;
  for (let waited = 0; waited < POLL_BUDGET_MS; attempts++) waited += pollDelayMs(attempts);
  return attempts;
})();
