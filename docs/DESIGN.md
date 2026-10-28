# evalmydocs backend design (working notes)

## Product

Public site: email signup, upload docs, run parse eval. Default free run: Reducto r-1 + hyperscalers
(Azure DI, AWS Textract, Google Document AI), judged by blind comparative judge (gpt-6-astra, OpenAI API).
We pay for default compute; keep docs/results. BYOK for others (LlamaParse, Extend, Datalab, Mistral, Pulse, Cohere).
Each run -> shareable link: summary, tradeoff curve list price vs accuracy. Self-host: deploy to own CF account or CLI.
UI + MCP come later (user will be prescriptive). Auth later (CurrentUser service stub).

## Decisions

- Monorepo: packages/core (Effect only, runtime-agnostic), apps/api (CF Worker: HttpApi, Workflows, D1, R2, DO).
- Effect v4 (effect@4.0.7; http, http-api, workflow, sql, ai modules live inside `effect`; @effect/sql-d1 4.0.7).
- Durable engine: Cloudflare Workflows (Effect Workflow needs cluster engine; none on Workers). Step bodies are Effect.
- Parse = submit step (returns vendor job ref) -> durable wait (step.sleep backoff) -> fetch step. Never double-pay.
- Errors: Transient vs Permanent tagged errors; Permanent -> NonRetryableError.
- Steps return small refs; blobs in R2, metadata in D1.
- Live progress: per-run Durable Object, WebSocket push (no polling — user hates polling).
- BYOK keys: AES-GCM encrypted in D1 with Worker secret, deleted at run end; never in workflow params.
- Page attribution: native per-page mapping from provider responses; split only where provider requires
  (Cohere: page images; Textract: per-page sync AnalyzeDocument; Google sync limit 15 pages -> chunk).
- Excluded: Gemini; google_mistral_ocr (duplicate of Mistral).
- Prices: versioned list-price table per preset; provider-reported cost when available.

## Reference material (docs/reference)

- reference_parse_eval.py: judge schema, label blinding (sha256 seed shuffle), summary metrics (mean, h2h, wilson CI).
- compare_prompt.txt: comparative judge prompt ({parse_sections}, {labels}).
- competitors_src/: request shapes, markdown extraction, cost formulas for every provider.
- configs.json: ideal provider configs. textract_layout.py / pulse_layout.py / layout.py: markdown converters.
- Textract list price used internally: $0.0685/page (analyze w/ layout+tables+forms+signatures).
- Provider creds: Doppler benchmarking/prd (AZURE_DI_ENDPOINT/KEY, COHERE, DATALAB, EXTEND, LLAMA_CLOUD, MISTRAL, PULSE, REDUCTO).
  Google DocAI: service account JSON + processor ids (see competitors README). AWS: needs static keys for Workers.

## Progress notes (verified live 2026-10-28)

- Unit of work = one (page, preset): each page is split to a single-page PDF + PNG; exact per-page attribution, uniform inputs.
- LlamaParse v2: POST api.cloud.llamaindex.ai/api/v2/parse {tier,version,source_url} -> {id,status}; GET /api/v2/parse/{id}?expand=markdown -> job.status COMPLETED, markdown.pages[].markdown.
- Extend: POST api.extend.ai/parse_runs (x-extend-api-version 2026-02-09) {file:{url},config} -> {id,status:PROCESSING}; GET /parse_runs/{id} -> status PROCESSED, output.chunks[].content, usage.credits ($0.01/credit; perf = 2 credits/page).
- Pulse: POST api.runpulse.com/extract_async {file_url} -> {job_id}; GET /job/{id} -> status completed, result.markdown, result.credits_used.
- Local creds: apps/api/.dev.vars from Doppler benchmarking/prd + reducto-api/dev (AWS, OPENAI). Google DocAI SA for layout processor not available locally.
- Live smoke (packages/core/scripts/smoke.ts) passed for reducto, azure, textract, mistral, extend (3 credits/page agentic), llamaparse, datalab, pulse. Cohere needs a public PNG URL (untested); Google untested (no layout processor creds).
- Core status: type-clean (`npx tsc -p packages/core`). Next: apps/api (D1 schema, R2, pdfium render to PNG, RunWorkflow, RunDO websocket, HttpApi).

## apps/api plan (written; migrations/0001_init.sql + wrangler.jsonc exist)

- R2 keys: documents/{docId}.pdf; pages/{pageId}.pdf + .png (pageId = `${docId}-${index}`); runs/{runId}/{pageId}/{presetId}.md + .raw.json.
- Blob URLs for providers: GET /blobs/{key}?exp&sig, HMAC-SHA256 with BLOB_SIGNING_KEY secret, PUBLIC_URL var. Local dev needs a tunnel (cloudflared quick tunnel) so vendors can fetch.
- RunWorkflow(params {runId}): step prepare:{docId} (split with core splitPages, render PNG with @embedpdf/pdfium `init({wasmBinary})` + FPDF_LoadMemDocument/FPDFBitmap_Create/FPDF_RenderPageBitmap/EPDF_PNG_EncodeRGBA, ~150 DPI) -> step create PageWorkflow batch (createBatch max 100) -> step.waitForEvent("pages-done") -> step summarize (core summarize over parses+verdicts; write runs.summary; delete run_credentials).
- PageWorkflow(params {runId,pageId}): per preset concurrently: step submit:{preset} (Done -> persist md/raw + parses row inside the step) else loop step.sleep(backoff 2s..60s) + step poll:{preset}:{n} up to ~30 min; failures after retries -> parses row status failed (do not fail page). Then step judge (core judgePage on succeeded presets; insert verdicts). Then step notify RunEvents DO.
- Step retries: {limit 5, delay "5 seconds", backoff exponential, timeout "5 minutes"}; ProviderError/JudgeError retryable=false -> NonRetryableError from "cloudflare:workflows".
- RunEvents DO (one per run): websocket hibernation broadcast of progress; counts finished pages; when all done -> env.RUN_WORKFLOW.get(runId).sendEvent({type:"pages-done"}). No polling anywhere in our system; vendor polling uses durable step.sleep.
- Credentials: hosted presets use env secrets; BYOK in run_credentials (AES-GCM, CREDENTIALS_KEY secret), loaded+decrypted inside steps, never in workflow params.
- HttpApi (effect/http-api): GET /v1/presets; POST /v1/documents (raw PDF body, ?filename) -> {documentId,pageCount}; POST /v1/runs {documentIds, presetIds?, credentials?} -> {runId, shareId}; GET /v1/runs/{id}; GET /v1/runs/{id}/pages/{pageId}; GET /v1/share/{shareId}; GET /v1/runs/{id}/events (websocket -> DO); GET /openapi.json.
- Auth stub: CurrentUser service from `x-evalmydocs-user` header in dev (AUTH_MODE=dev); real email auth later.
