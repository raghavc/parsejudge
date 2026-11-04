# Stress report

Target: `devin/1793812544-stuck-run-fixes` at `d627503` (hardening PRs #3, #4, #5, #6, #7 and the Azure `base64Source` change merged).
Everything ran locally: `wrangler dev` with local D1, R2, Durable Objects and Workflows, a fake provider and judge server, and generated PDFs. No production resource or provider was called.

## How to run

```sh
cd apps/api
pnpm stress <scenario>     # smoke, batch, batch-persistent, continue-missing, continue-errored, judge-429, steps, restart, concurrent, large, hostile
STRESS_API_PORT=8800 STRESS_FAKE_PORT=8802 pnpm stress batch   # run several scenarios at the same time
```

Output goes to `apps/api/.wrangler/stress/<scenario>-<time>/`: `report.json`, `wrangler.log`, and the wrangler state.

## What the harness does

- `stress/worker.ts` wraps the real worker. It sends provider and judge hosts to the fake server, and can make `createBatch` fail (`STRESS_BATCH_DROP`, `STRESS_BATCH_MODE`) or make named workflow steps throw `NonRetryableError` (`STRESS_STEP_FAIL`).
- `stress/fake.ts` serves Reducto, Mistral, the small model and the OpenRouter judge. Each request gets one outcome: a normal answer, 429, 500, 200 with an `error` object, 200 with `{"error":{"code":429}}`, an empty body, malformed JSON, a wrong shape, a slow answer, a hang, a dropped connection, a failed job, or a job that never finishes.
- `stress/pdf.ts` generates small invoice and statement PDFs (text, tables, page numbers).
- `stress/harness.ts` uploads the PDFs, starts the runs, polls D1, kills wrangler on schedule, calls `POST /v1/runs/:id/continue` on runs that stop changing, and reads the local workflow state for runs that do not finish.

## Pass condition

A scenario passes when, before its deadline:

1. Every run is `succeeded` or `failed`.
2. Every (page, preset) has a parse row (`succeeded` or `failed`).
3. Every page with a succeeded parse has verdicts or a `judge_failures` row.

## Results

| Scenario | What it does | Runs | Result |
|---|---|---|---|
| `smoke` | 1 run, 3 pages, no faults | 1 | Pass. `48598a0c` succeeded. |
| `batch` | `createBatch` returns an error entry for 2% of instances the first time it sees them | 4 × 80 pages | Pass. All 4 succeeded with 240/240 cells (`555f3f2e`, `2e17b39f`, `70bd93ce`, `9b95e4b1`). The `fan out` step retry starts the dropped pages. |
| `batch-persistent` | Same 2% get an error entry on every call | 4 × 80 | Terminal, check 2 fails. `932ac1d2` and `270675b5` failed with `Could not start N page workflows: <ids>`; `9a6d8f05` and `b03d985f` succeeded. The failed runs have 234/240 and 237/240 cells: the pages that never started have no parse row (finding 2). |
| `continue-missing` | `createBatch` loses 2% of instances with no error entry; Continue after 60 s idle | 2 × 80 | Pass. Continue returned `{"skipped":3}` and `{"skipped":1}`; both runs succeeded with "Skipped by user" rows (`b394f8ca`, `4a2c3af7`). |
| `continue-errored` | `summarize` and `record failure` always throw, so the RunWorkflow errors and the run stays `running`; Continue after 60 s idle | 2 × 10 | Pass. Continue returned `{"skipped":0}`, found no live RunWorkflow, summarized directly; both succeeded (`fe1b3286`, `6fe77435`). |
| `judge-429` | 50% of judge calls get HTTP 200 `{"error":{"code":429}}` | 4 × 20 | 3 of 4 succeeded. `bd76fff1` was still `running` at 39 min: its last page `86cacfbf…-9` failed judge attempt 8 with the 429 body and was in the final 1280 s backoff of `JUDGE_RETRY` (about 43 min of backoff in total). After attempt 9 the page gets a verdict or a `judge_failures` row, so the run ends by itself, but later than the 45 min deadline. |
| `steps` | 10% of `record*`, `report*`, `notify*`, `summarize` steps throw `NonRetryableError`, plus mixed HTTP faults; Continue after 300 s idle | 4 × 40 | 3 of 4 succeeded after Continue (`49049fc6` `{"skipped":5}`, `5235fccb` `{"skipped":2}`, `11299a55` `{"skipped":3}`). Without Continue they wait for the 6 h `PAGES_TIMEOUT` (finding 3). `ac186792` is still `running` at 30 min (finding 4). |
| `restart` | Mixed HTTP faults; wrangler is killed (`SIGKILL`) at 45 s, 120 s and 240 s; Continue after 180 s idle | 4 × 40 | Terminal only through Continue, check 3 fails. All 4 succeeded after Continue (`{"skipped":16}`, `{"skipped":40}` ×3). In `c49deee1`, `34628cfa`, `815c2ac0` all 40 pages have succeeded parses but no verdicts and no `judge_failures` row (finding 1). `b1e8763f`: 4 such pages. |
| `concurrent` | 12 runs at once; mixed HTTP faults | 12 × 20 | Pass. All 12 succeeded; every failed cell and judge failure has a row. |
| `large` | 4 documents × 100 pages in one run; mixed HTTP faults | 1 × 400 | Pass. `06b9e4ef` succeeded in 631 s: 1200/1200 cells, 12 recorded parse failures, 6 recorded judge failures. |
| `hostile` | 15% 429, 15% dropped connections, 10% hangs, 10% slow, 10% 200-with-`error`, 5% jobs that never finish | 2 × 10 | Not finished at report time. At 39 min both runs were still `running` with 29/30 cells; the remaining cells were retrying hung (3 min `REQUEST_TIMEOUT`) and dropped calls. No run had failed silently. |

"Mixed HTTP faults" is 5% 429, 3% 500, 3% 200-with-`error`, 2% each of empty body, malformed JSON, wrong shape, slow, dropped connection and failed provider job, and 0.2% hangs. Short run IDs are the first 8 characters; full IDs are in each `report.json`.

## Runs that did not reach a terminal state

State at report time. Scenarios still running: `judge-429`, `steps`, `hostile`.

| Run | Scenario | Stuck step | Evidence | Ends by itself? |
|---|---|---|---|---|
| `ac186792-3c28-47d4-ae76-717aa934833a` | `steps` | RunWorkflow `errored` after `record failure` threw | Workflow log: `summarize` failed (injected), then `record failure` failed (injected), instance status `errored`; run row `running`, 39/40 pages judged, Continue already called once at 608 s | No. Needs a second Continue (finding 4). |
| `bd76fff1-c093-4ae9-8bf3-e02fc98dcb12` | `judge-429` | page `86cacfbf-54cc-46d2-89d7-c360a082925f-9`, step `judge` | Page workflow log: `judge-1` attempt 8 failed "Judge error 429: Rate limit exceeded (stress)", `retryDelayMs: 1280000` | Yes, after attempt 9 (about 43 min of judge backoff). |
| `427e1c79-bc07-425d-bcbc-e77ff41ff60d`, `2ed7a230-69ce-4e27-9e93-1574a700a9db` | `hostile` | provider `poll`/`submit` steps on the last cell | 29/30 cells after 39 min; wrangler log shows "Request timed out after 3 minutes" retries | Expected yes: every step has bounded retries. Not confirmed at report time. |

The `restart` and `steps` runs that reached `succeeded` did so only because the harness called Continue.

## Failure paths found

Line numbers are on `d627503`. None of these are fixed in this PR (the harness owns only `apps/api/stress/**`).

1. **Continue drops judging for pages that already parsed.** `apps/api/src/run.ts:285-298`. `continueRun` writes "Skipped by user" rows only for (page, preset) cells with no row (`INSERT OR IGNORE`), marks every pending page done, and stops its workflow. A page whose parses succeeded but whose judge had not run ends with neither verdicts nor a `judge_failures` row, and the run is `succeeded`. Seen in `restart`: 3 runs succeeded with 0 of 40 pages judged. Possible fix: for each skipped page that has a succeeded parse and no verdict, insert a `judge_failures` row ("Skipped by user").
2. **A failed run leaves its page workflows running and unstarted pages without rows.** `apps/api/src/workflows.ts:189-197` (`fan out`) and `:251-253` (`recordFailure` → `finishRun`, `apps/api/src/run.ts:180-187`). When a run fails while pages are running (for example `fan out` failed after its retries for some instances), the run becomes `failed` and its credentials are deleted, but the pages that did start keep running: they call providers and write parse rows into a failed run. A page that started after the credentials were deleted records "needs your own API key" failures (seen in a `steps` run with a broken harness proxy). Pages that never started have no parse row. Seen in `batch-persistent` (`932ac1d2`: 6 cells missing; `270675b5`: 3). The run error does list the missing instance IDs, so the failure is not silent. Possible fix: in `recordFailure`, stop live page instances (as `stopPage` does) and write failed parse rows for pages with no row.
3. **A page that cannot report holds its run for 6 hours.** `apps/api/src/workflows.ts:344-346`. If the page's `report` step fails after `MUST` (about 85 minutes of retries), `Effect.orDie` ends the page workflow without `pageDone`. The run then waits for `pages-done` until `PAGES_TIMEOUT` (6 hours) and fails. Continue recovers it. Seen in `steps` (Continue skipped 2 to 7 pages per run). Terminal, but only after 6 hours or a manual Continue.
4. **A RunWorkflow that errors leaves the run `running` with nothing to restart it.** `apps/api/src/workflows.ts:251-253`. If `summarize` and then `record failure` both fail after their retries, the RunWorkflow ends in `errored` and the run row stays `running`. Only a manual Continue finishes it (`continue-errored` passes because the harness calls Continue). Seen in `steps` run `ac186792`: Continue at 608 s woke the RunWorkflow, then `summarize` and `record failure` failed again; the run stayed `running` until the deadline.
5. **Any `waitForEvent` error is reported as a 6-hour timeout.** `apps/api/src/workflows.ts:228-240`. `waitForPages` turns every `StepFailed` from `step.waitForEvent` into "N of M pages did not finish within 6 hours", even when the step failed after seconds. Seen with a broken harness step proxy: runs failed after 5 s with that message. Low impact; the message misleads.
6. **The judge logs usage for a 200-with-`error` answer.** `packages/core/src/judge.ts:177`. `onUsage` runs before the `error` check at line 179, so the usage log shows a judge call with `status: "ok"` for a rate-limited answer. Low impact.

Worked as intended on `d627503`: `createBatch` error entries fail the `fan out` step and then the run (`batch`, `batch-persistent`); render, provider and judge failures are recorded per cell or page (`concurrent`, `large`); HTTP 200 `{"error":{"code":429}}` from the judge is retried with backoff and does not fail the page early (`judge-429`); Continue finishes runs with lost page instances and runs whose RunWorkflow errored.

## Harness limits

- Local Miniflare does not resume `running` workflow instances after wrangler is killed (`SIGKILL`). The instances stay `running` with no further steps, so the `restart` scenario needs Continue to finish its runs. Production Workflows replay instances after a restart; this was not tested here.
- `continue-errored` makes `summarize` and `record failure` fail every time, so the RunWorkflow errors while the run is `running`. In production this needs both D1 and the steps' 85 minutes of retries to fail.
