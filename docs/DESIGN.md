# Design

## Run lifecycle

1. `POST /v1/documents` detects the format from the bytes (PDF, DOCX or PPTX), converts DOCX and PPTX to PDF
   (see Conversion), and stores the upload, the PDF and its page count.
2. `POST /v1/runs` validates presets and ownership, encrypts BYOK keys into D1, and starts `RunWorkflow`.
3. `RunWorkflow` splits each document into one-page PDFs and starts one `PageWorkflow` per page. It then
   waits for the `pages-done` event.
4. `PageWorkflow` renders its page to PNG (PDFium WASM, 200 DPI, at most 2400 px), runs every preset on the
   page in parallel, then judges all successful parses in one call.
5. The run's `RunEvents` Durable Object counts finished pages, pushes progress over WebSocket, and sends
   `pages-done` to `RunWorkflow` when the last page finishes.
6. `RunWorkflow` computes the summary, stores it on the run, and deletes the run's credentials.

## Execution rules

- One unit of work is one (page, preset) cell. Every provider gets the same page PNG, whatever the upload
  format, so a provider that cannot read DOCX (Textract) is compared on the same input as one that can.
- Each provider has a concurrency limit per API key: 100 requests by default, overridden per provider (or
  `judge`) in the `MAX_CONCURRENCY` JSON var. A `ProviderSlots` Durable Object per (provider, key) holds the
  slots as leases. A page waits on a Workflow event, and a release wakes the next page in FIFO order.
  Leases expire after an hour, so a workflow that dies frees its slot. Hosted and BYOK keys have separate pools.
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

## Conversion

DOCX and PPTX go to a `Converter` Cloudflare Container: `POST /convert` with the document as the body and its
MIME type as content-type, answered with the PDF (422 if the document is unreadable). The container image
decides the engine:

- This repo ships `containers/libreoffice` (headless LibreOffice), the default for self-hosting.
- parsejudge.com points `image` at a private image built from Reducto's document engine. It is not open
  source, so it is not in this repo; it implements the same contract.

## Not built yet

- Email signup and sessions. `AUTH_MODE=dev` trusts the `x-parsejudge-user` header.
- Quotas, UI, MCP server, versioned pricing table.
