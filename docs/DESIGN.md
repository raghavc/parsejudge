# Design

## Run lifecycle

1. `POST /v1/documents` stores the PDF in R2 and its page count in D1.
2. `POST /v1/runs` validates presets and ownership, encrypts BYOK keys into D1, and starts `RunWorkflow`.
3. `RunWorkflow` splits each document into one-page PDFs, renders each page to PNG (PDFium WASM), and starts one
   `PageWorkflow` per page. It then waits for the `pages-done` event.
4. `PageWorkflow` runs every preset on the page in parallel, then judges all successful parses in one call.
5. The run's `RunEvents` Durable Object counts finished pages, pushes progress over WebSocket, and sends
   `pages-done` to `RunWorkflow` when the last page finishes.
6. `RunWorkflow` computes the summary, stores it on the run, and deletes the run's credentials.

## Execution rules

- One unit of work is one (page, preset) cell. Every provider gets the same one-page PDF.
- A parse is: `submit` step, then durable `sleep` + `poll` steps with backoff. A retry of a later step never
  resubmits, so a vendor job is never paid for twice.
- Provider and judge errors carry `retryable`. Non-retryable errors become `NonRetryableError`.
- A failed parse is recorded and does not fail the page. A failed judge call is recorded in `judge_failures`
  and does not block the run.
- Workflow steps return small values. Markdown and raw provider output go to R2. State goes to D1.
- Keys are never in workflow params. Hosted presets use Worker secrets. BYOK keys are AES-GCM encrypted
  with the run id as associated data and are deleted when the run ends.
- Providers read pages from short-lived HMAC-signed `/blobs/...` URLs.

## Judge

- Version `compare-v1`, stored on every run with the judge model.
- Parses are labelled `parse_a`, `parse_b`, ... in an order derived from SHA-256 of `pageId:presetId`.
- Output is JSON-schema constrained and validated: every parse scored once, integer scores 1-10.

## Summary

- Per preset: mean and median score, failed pages, high-severity error rate with Wilson 95% interval,
  error counts by category, list price, observed provider cost, latency p50/p95.
- Head-to-head per page pair. A failed parse scores 1.
- Tradeoff: list price vs mean score, with Pareto-optimal points marked.

## Not built yet

- Email signup and sessions. `AUTH_MODE=dev` trusts the `x-evalmydocs-user` header.
- Quotas, UI, MCP server, versioned pricing table.
