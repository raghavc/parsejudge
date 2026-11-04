# Stress report

Target: `beta`. All scenarios ran on `4197b8e` (OIDC workload identity, the Effect conversion, and the stress-bug fixes) with the harness in this directory. `ea2fa27` changes only the `subject_token_type` string, and `cf36816` changes only the web app. `smoke` and `token` were run again on `cf36816` and passed (token: 70 exchanges ok, 10 × 401, 25 × 503, 4/4 runs succeeded, 60/60 cells each).
Everything ran locally: `wrangler dev` with local D1, R2, Durable Objects and Workflows, a fake provider, judge and OpenAI token server, and generated PDFs. No production resource, provider or OpenAI endpoint was called.

## 1. How to run

```sh
cd apps/api
pnpm stress <scenario>
STRESS_API_PORT=8800 STRESS_FAKE_PORT=8802 pnpm stress batch   # run several scenarios at the same time
```

Scenarios: `smoke`, `batch`, `batch-persistent`, `continue-missing`, `continue-errored`, `judge-429`, `judge-fallback`, `judge-quota`, `token`, `steps`, `restart`, `concurrent`, `large`, `hostile`.

Output goes to `apps/api/.wrangler/stress/<scenario>-<time>/`: `report.json`, `instances.json` (workflow evidence for runs that did not finish), `wrangler.log`, and the wrangler state.

## 2. What the harness does

- `stress/worker.ts` wraps the real worker. It sends provider hosts to the fake server. It can make `createBatch` return error entries or lose instances (`STRESS_BATCH_DROP`, `STRESS_BATCH_MODE`). It can make named workflow steps throw `NonRetryableError` (`STRESS_STEP_FAIL`).
- `stress/fake.ts` serves Reducto, Mistral, OpenRouter (small model), the OpenAI token exchange (`POST /oauth/token`) and OpenAI chat completions (`POST /openai/v1/chat/completions`). Each request gets one outcome: a normal answer, 429, 500, 200 with an `error` object, 200 with `{"error":{"code":429}}`, an empty body, malformed JSON, a wrong shape, a slow answer, a hang, a dropped connection, a failed job, or a job that never finishes. OpenAI-only faults: 429 `rate_limit_exceeded` on the primary model only, 429 `insufficient_quota`, and token endpoint 401 and 503.
- The fake generates a P-256 key per run. The harness passes the private JWK (with `kid`) to the worker as `OPENAI_SIGNING_KEY`. The token route checks the grant type, the subject token type, the ES256 signature and `exp` of the subject JWT before it answers `{"access_token":"x","expires_in":3600}`. A bad JWT gets 401 and is counted as `token invalid: <reason>`. No run had one.
- `stress/wrangler.jsonc` has no `mtls_certificates` binding. It points `OPENAI_BASE_URL` and `OPENAI_AUTH_URL` at the fake. The judge models are `stress-primary`, `stress-fallback-1`, `stress-fallback-2`.
- `stress/pdf.ts` generates small invoice and statement PDFs.
- `stress/harness.ts` uploads the PDFs, starts the runs, polls D1, reads each unfinished run through `GET /v1/runs/:id` (as the web app does, which runs `reconcileRun`), kills wrangler on schedule, calls `POST /v1/runs/:id/continue` on runs that stop changing (and, in `continue-errored`, on failed runs), and reads the local workflow state for runs that do not finish.

## 3. Pass condition

A scenario passes when, before its deadline:

1. Every run is `succeeded` or `failed`.
2. Every (page, preset) has a parse row (`succeeded` or `failed`).
3. Every page with a succeeded parse has verdicts or a `judge_failures` row. This also covers runs that Continue finished.

## 4. Results

| Scenario | What it does | Runs | Result |
|---|---|---|---|
| `smoke` | 1 run, 3 pages, no faults | 1 | Pass. |
| `batch` | `createBatch` returns an error entry for 2% of instances the first time it sees them | 4 × 80 pages | Pass. All succeeded, 240/240 cells each. |
| `batch-persistent` | Same 2%, error entry on every call | 4 × 80 | All terminal. Check 2 fails (finding 2). `a3f955d3`, `c1c28288`, `bd3c394c` failed with `Could not start N page workflows: <ids>`; they have 237/240, 234/240, 234/240 cells. `92c7741e` succeeded. |
| `continue-missing` | `createBatch` loses 5% of instances with no error entry; Continue after 60 s idle | 2 × 80 | Pass. Continue returned `{"skipped":3}` and `{"skipped":6}`; both succeeded with "Skipped by user" rows. |
| `continue-errored` | `summarize` and `record failure` always throw, so the RunWorkflow errors; Continue on the failed run | 2 × 10 | Pass. Reading the run through the API marked both runs `failed` ("Run workflow errored: ...") within 10 s. Continue then returned `{"skipped":0}` and both succeeded with all verdicts. |
| `judge-429` | 50% of judge calls get HTTP 200 `{"error":{"code":429}}` | 4 × 20 | Pass. All succeeded, every page judged. The judge moved to the fallback models on these answers. |
| `judge-fallback` | Every call to `stress-primary` gets HTTP 429 `rate_limit_exceeded` | 4 × 20 | Pass. All succeeded, every page judged. Fake counts: 80 × `stress-primary` 429, 80 × `stress-fallback-1` ok. |
| `judge-quota` | 30% of judge calls get HTTP 429 `insufficient_quota` | 4 × 20 | Pass. All succeeded. 23 quota answers, no fallback call after any of them, 23 `judge_failures` rows "Judge project spend limit reached". |
| `token` | Token endpoint: 10% 401, 30% 503; tokens last 60 s, so every judge call exchanges a token | 4 × 20 | Pass. All succeeded. 9 × 401 became `judge_failures` rows (not retried); 31 × 503 were retried. |
| `steps` | 10% of `record*`, `report*`, `notify*`, `summarize` steps throw `NonRetryableError`, plus mixed HTTP faults; Continue after 300 s idle | 4 × 40 | All terminal, but only through Continue (finding 3). Check 2 fails: `c856ce26` succeeded with 119/120 cells (finding 7). `00b0fc89` failed after Continue because `summarize` threw again. |
| `restart` | Mixed HTTP faults; wrangler killed (`SIGKILL`) at 45 s, 120 s and 240 s; Continue after 180 s idle | 4 × 40 | Pass, through Continue (harness limit 1). Continue returned `{"skipped":40}` ×3 and `{"skipped":17}`. Every skipped page with a succeeded parse has a `judge_failures` row. |
| `concurrent` | 12 runs at once; mixed HTTP faults | 12 × 20 | Pass. |
| `large` | 4 documents × 100 pages in one run; mixed HTTP faults | 1 × 400 | Pass on the second attempt: `49d45575` succeeded in 687 s, 1200/1200 cells, 8 `judge_failures` rows. The first attempt hit a local workerd crash (section 5). |
| `hostile` | 15% 429, 15% dropped connections, 10% hangs, 10% slow, 10% 200-with-`error`, 5% jobs that never finish | 2 × 10 | Pass. Both succeeded in 848 s, 30/30 cells. |

"Mixed HTTP faults" is 5% 429, 3% 500, 3% 200-with-`error`, 2% each of empty body, malformed JSON, wrong shape, slow, dropped connection and failed provider job, and 0.2% hangs. Short run IDs are the first 8 characters; full IDs are in each `report.json`.

## 5. Runs that did not reach a terminal state

None in a passing scenario. One run did not end, and the cause is the local runtime, not the app:

- `large` first attempt, run `b4b169c5-2ac3-486c-8cad-4847851b7269`: `running` after 12 minutes with 12/1200 cells. `wrangler.log` shows `The Workers runtime crashed unexpectedly and is being restarted (crash #1)` at 19:17:11 UTC, while 14 scenarios ran at the same time on one machine. The workflow log stops at that time: 11 page instances started `release mistral_ocr_4_1` at 19:17:11.353 and never finished it, so their Mistral slots were never freed, and 374 instances wait for `slot-mistral_ocr_4_1`. The RunWorkflow waits for `pages done`. This is harness limit 1. Continue would end it. The same scenario on a quiet machine passed (section 4).

## 6. Findings

Line numbers are on `beta` at `ea2fa27`.

Fixed since `d627503`: finding 1 (Continue now writes `judge_failures` rows for skipped pages with succeeded parses, `apps/api/src/run.ts:391`), finding 4 (`reconcileRun` marks a run with an errored RunWorkflow `failed` when it is read, `apps/api/src/run.ts:340`), and finding 6 (usage is logged only after a good judge answer). Finding 5 is improved: the message now includes the step error (`apps/api/src/workflows.ts:378`).

Still open:

2. **Pages that never started have no parse row in a failed run.** `apps/api/src/workflows.ts:78` and `stopPendingPages` (`apps/api/src/run.ts:329`). When `createBatch` keeps refusing some instances, the run fails with `Could not start N page workflows: <ids>`. The started pages are stopped now. The pages that never started get no parse rows. The run error lists them, so this is not silent. Seen in `batch-persistent`.
3. **A page that cannot report holds its run for 6 hours.** `apps/api/src/workflows.ts:470`. Left as is by decision. Seen in `steps`: Continue skipped 2 to 7 pages per run.
7. **New: a parse failure that cannot be recorded is dropped, and the run still succeeds.** `apps/api/src/workflows.ts:552-560`. When a cell fails and its `record failure <preset>` step also fails, `bestEffort` (`:102-106`) only logs "Could not record parse failure". The page then reports done, and the run summarizes as `succeeded` with no row for that cell. Evidence: `steps` run `c856ce26-cf45-4095-a3d9-ede6c9bd8ce9`, page `968d8a35-1e89-4c8a-bc83-37261429a4b1-6`, preset `reducto_r1_mini`. Workflow log: `poll reducto_r1_mini 0` failed ("job Failed: stress: injected job failure"), then `record failure reducto_r1_mini` failed (injected), then `report reducto_r1_mini` and `report` succeeded. The run has 119/120 cells. In production this needs D1 writes to fail through all `MUST` retries (about 85 minutes). Possible fix: let the failure reach the run (for example, fail the run or record the cell from `summarize` when a cell has no row). Not fixed: app code.

## 7. Harness limits

1. Local Miniflare does not resume `running` workflow instances after workerd stops (our `SIGKILL`, or a runtime crash). The instances stay `running` with no further steps. `restart` needs Continue for this reason. Production Workflows replay instances after a restart; this was not tested here.
2. Fault injection with `NonRetryableError` skips the step's retries. Findings 3 and 7 need about 85 minutes of D1 failures in production.
