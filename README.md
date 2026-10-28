# parsejudge

Open-source document parser evaluation. Upload PDFs, parse every page with several providers, and score the
results with a blind comparative LLM judge. Each run produces a shareable summary: accuracy, failures, cost,
latency, head-to-head results and a list-price vs accuracy curve.

## Layout

- `packages/core`: provider adapters, judge, scoring. Effect only, no Cloudflare imports.
- `apps/api`: Cloudflare Worker. HTTP API, Workflows, D1, R2, one Durable Object per run.
- `docs/DESIGN.md`: how a run executes.

## Providers

| Provider                    | Presets                               | Hosted run         |
| --------------------------- | ------------------------------------- | ------------------ |
| Reducto                     | R-1                                   | yes                |
| Azure Document Intelligence | layout, high-res                      | yes                |
| AWS Textract                | layout, tables, forms, signatures     | yes                |
| Google Document AI          | Layout Parser v1.6                    | yes                |
| Mistral                     | OCR 4.1                               | bring your own key |
| Extend                      | performance, agentic                  | bring your own key |
| LlamaParse                  | agentic-plus, agentic, cost-effective | bring your own key |
| Datalab                     | accurate, balanced, fast              | bring your own key |
| Pulse                       | Ultra 2, refine                       | bring your own key |
| Cohere                      | Parse v5                              | bring your own key |

`GET /v1/presets` returns the full list with list prices.

## Run locally

Requirements: Node 22+, pnpm 10.

```sh
pnpm install
cd apps/api
cp .dev.vars.example .dev.vars        # fill in the keys you have
npx wrangler d1 migrations apply parsejudge --local
cloudflared tunnel --url http://localhost:8787   # providers fetch pages from a public URL
npx wrangler dev --var PUBLIC_URL:<tunnel url>
python3 scripts/e2e.py file.pdf reducto_r1 aws_textract
```

Progress streams on `ws://localhost:8787/v1/runs/<runId>/events`. Results: `GET /v1/runs/<runId>`.
The OpenAPI document is at `/openapi.json`.

## Self-host

Deploy `apps/api` to your own Cloudflare account: create the D1 database and R2 bucket named in
`wrangler.jsonc`, set the secrets from `.dev.vars.example` with `wrangler secret put`, apply migrations with
`--remote`, then `wrangler deploy`. DOCX and PPTX conversion runs in the LibreOffice container in
`containers/libreoffice`; Wrangler builds it with Docker on deploy and in `wrangler dev`.

## Checks

```sh
pnpm check && pnpm test && pnpm lint
```
