/** Delay before poll `attempt`: 1 s, growing 1.5x, capped at 10 s, so a finished job is seen within 10 s. */
export const pollDelayMs = (attempt: number): number => Math.round(Math.min(1000 * 1.5 ** attempt, 10_000));

/** Longest a vendor job may run before the parse counts as timed out. */
export const POLL_BUDGET_MS = 30 * 60 * 1000;

/** Polls that fit in `POLL_BUDGET_MS`. Each poll costs two workflow steps (sleep, poll). */
export const MAX_POLLS = ((): number => {
  let attempts = 0;
  for (let waited = 0; waited < POLL_BUDGET_MS; attempts++) waited += pollDelayMs(attempts);
  return attempts;
})();
