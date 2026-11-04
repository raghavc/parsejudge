# Vendor fairness audit

## 1. Purpose

ParseJudge publishes comparative parse quality results. This audit checks that each preset calls its vendor correctly and that each adapter keeps all the content the vendor returns. A vendor must not be able to say "you ran us wrong".

## 2. Method

1. For each preset, we compared the request config with the vendor's current official docs and with the `competitors.reducto.ai` worker (`reductoai/api`, `cloudflare/competitors/src/providers.ts`).
2. We ran every preset (14) on 14 single-page documents with the adapter code in this repo, called locally against the vendor APIs. Keys came from Doppler `benchmarking/prd`. We did not use ParseJudge production, its Cloudflare account, D1, R2, or its secrets.
3. Each page went to the vendor as ParseJudge sends it: one PNG rendered at 200 DPI, longest side at most 2400 px (`apps/api/src/render.ts`), from a short-lived public URL.
4. For each result we compared the raw vendor response with the final markdown. We checked vendor block lists (Reducto blocks, Extend blocks, Mistral blocks/header/footer, Textract WORD/CELL/MERGED_CELL blocks, LlamaParse page fields, Cohere `finish_reason`) for text that is in the raw response but not in the markdown. We also searched the markdown for left-over placeholders: self-links, image refs, `<!-- -->` comments, table ids, page separators.

## 3. Documents tested

All presets ran on all 14 pages. Rendered pages: `s3://reducto-shared-ml-workspace/raunak/parsejudge-fairness/docs/`.

| Page                          | Source                                              | Tests                                                      |
| ----------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `dense_merged_table_bls_a1`   | BLS Employment Situation, Jan 2024, Table A-1       | dense table, merged header cells, header/footer, footnotes |
| `multipage_table_bls_b1_cont` | BLS Table B-1, continued page                       | table that continues from the previous page                |
| `scanned_skewed_bls_a1`       | Table A-1, grayscale, 1.8° skew, noise, blur        | scanned, skewed                                            |
| `table_attention_p8`          | "Attention Is All You Need", p. 8                   | dense numeric table, two-level header                      |
| `table_figure_resnet_p6`      | ResNet paper, p. 6                                  | three tables, figure                                       |
| `multicolumn_resnet_p1`       | ResNet paper, p. 1                                  | two columns, chart, margin stamp                           |
| `rotated90_resnet_p1`         | ResNet p. 1 rotated 90°                             | rotated page                                               |
| `charts_mpr_p53`              | Fed Monetary Policy Report, Jul 2024, p. 47         | running header with page number, table                     |
| `form_w9_filled`              | IRS W-9, filled                                     | key-value form, checkboxes                                 |
| `form_1040_checkboxes`        | IRS 1040 p. 1, partly filled                        | dense form, many checkboxes                                |
| `handwriting_letter`          | Wikimedia "Handwritten Letter of Resignation" photo | handwriting, photo                                         |
| `japanese_boj_p1`             | Bank of Japan Outlook Report, Jan 2024, p. 1        | Japanese, vertical letter-spaced header                    |
| `japanese_charts_boj_p10`     | same report, p. 10                                  | Japanese table with ranges                                 |
| `german_table_btd_p35`        | Bundestag Drucksache 20/9100, p. 35                 | German table, running header                               |

## 4. Summary

| Vendor                      | Preset(s)                                                                    | Verdict                                                             |
| --------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Reducto                     | `reducto_r1`, `reducto_r1_mini`                                              | Fair                                                                |
| Azure Document Intelligence | `azure_layout_high_res`                                                      | Fair                                                                |
| AWS Textract                | `aws_textract`                                                               | Fixed (merged cells, page numbers)                                  |
| Mistral OCR                 | `mistral_ocr_4_1`                                                            | Fair (table fix from PR #6 holds); image descriptions need decision |
| Extend                      | `extend_performance_agentic`                                                 | Fixed (engine version 2.0.0 to 2.1.0)                               |
| LlamaParse                  | `llamaparse_agentic_plus`, `llamaparse_agentic`, `llamaparse_cost_effective` | Fixed (page headers/footers dropped)                                |
| Datalab                     | `datalab_accurate`, `datalab_balanced`, `datalab_fast`                       | Fair                                                                |
| Pulse                       | `pulse_ultra_2_refine`                                                       | Needs decision (`refine` fails on the 1040 page)                    |
| Cohere                      | `cohere_parse_v5`                                                            | Needs decision (truncated output is accepted)                       |

## 5. Findings per vendor

### 5.1 Reducto

- Preset: `{ formatting: { merge_tables: false }, settings: { model: "r-1" } }`; r-1 mini adds `alpha: { r1_model: "r1mini" }`.
- Docs: r-1 is the current model.
- competitors.reducto.ai: passes the caller config to `POST /parse` and joins `result.chunks[].content`, with URL results fetched. Same as ours.
- Evidence: 182 raw blocks (r-1) and 179 (r-1 mini) checked; 0 missing from the markdown. URL-backed results are handled.
- Verdict: fair.

### 5.2 Azure Document Intelligence

- Preset: `prebuilt-layout`, `features: ["ocrHighResolution"]`, API `2024-11-30`, `outputContentFormat=markdown`, page bytes as `base64Source`.
- Docs: `2024-11-30` is the latest GA API version. `ocrHighResolution` is the add-on for small text.
- competitors.reducto.ai: same model, API version and output format; it sends `urlSource` instead of bytes.
- Evidence: the adapter returns `analyzeResult.content` unchanged. Page headers, footers and page numbers stay in Azure's own comments, for example `<!-- PageHeader="MONETARY POLICY REPORT: JULY 2024 47" -->`. The text is kept.
- Verdict: fair.

### 5.3 AWS Textract

- Preset: `AnalyzeDocument`, `featureTypes: ["LAYOUT", "TABLES"]`. The renderer is ours: Textract returns blocks, not markdown.
- Docs: `FORMS`, `SIGNATURES` and `QUERIES` are optional extra features with extra cost. Textract does not support Japanese.
- competitors.reducto.ai: no Textract provider.
- Finding 1 (fixed): merged table cells were split. Textract reports spans on `MERGED_CELL` blocks, linked from the `TABLE` with relationship type `MERGED_CELL`. Their child `CELL` blocks always have span 1. The renderer read only `CELL` blocks.
  - Raw: `MERGED_CELL RowIndex 1 ColumnIndex 2 ColumnSpan 3` with children (1,2), (1,3), (1,4).
  - Before: `<td>Not</td><td>seasonally</td><td>adjusted</td>`
  - After: `<td colspan="3">Not seasonally adjusted</td><td colspan="6">Seasonally adjusted</td>`
- Finding 2 (fixed): `LAYOUT_PAGE_NUMBER` blocks were dropped on purpose. Every other vendor keeps page numbers. Raw has `LINE "47"`; the final markdown had no `47`. The block is now rendered as text.
- Tests: `packages/core/test/textract.test.ts`, with trimmed real responses in `test/fixtures/responses/textract-*.json`.
- Verdict: fixed. Japanese output is near empty because Textract does not support Japanese. That is a vendor limit, not an adapter bug.

### 5.4 Mistral OCR

- Preset: `{ model: "mistral-ocr-4-1", table_format: "html" }`.
- Docs: `mistral-ocr-4-1` is the latest OCR model. Headers and footers stay inline unless `extract_header`/`extract_footer` is set. Image descriptions need annotations (`bbox_annotation_format`), which cost extra.
- competitors.reducto.ai: model `mistral-ocr-latest`, `table_format: "html"` by default, `document_url` input. Its parser joins `pages[].markdown` only, so it has the table bug fixed here in PR #6.
- Evidence: all `[tbl-N.html](tbl-N.html)` links are replaced by their tables. 232 raw blocks checked, 0 missing. The remaining self-links are image placeholders, for example `![img-0.jpeg](img-0.jpeg)` on the ResNet pages. Mistral returns only the crop box for them, with no text.
- Verdict: fair. Whether to buy image annotations is a decision (section 6).

### 5.5 Extend

- Preset: `parse_performance`, markdown target, page chunks, agentic text and tables, HTML tables with cell blocks, figures with advanced chart extraction, signature detection.
- Docs: Parse Performance is the highest-quality engine. Its current stable version is `2.1.0` (default for `latest`). Rotation correction is on by default.
- competitors.reducto.ai: passes caller config with `target: "markdown"` as the only default; no engine pin.
- Finding (fixed): the preset pinned `engineVersion: "2.0.0"`. The raw response confirms it ran `engineVersion: "2.0.0"`. The preset now uses `2.1.0`. All 14 pages parsed with `2.1.0`; the raw response confirms `engineVersion: "2.1.0"`.
- Evidence: 158 raw blocks checked, 0 missing. `<page_number>` tags are Extend's own markdown and are kept.
- Verdict: fixed. Extend results change from this PR on.

### 5.6 LlamaParse

- Presets: `tier` `agentic_plus` / `agentic` / `cost_effective`, `version: "latest"`, `disable_cache: true`; poll with `expand=markdown`.
- Docs: tiers are `fast`, `cost_effective`, `agentic`, `agentic_plus`. `agentic_plus` turns on specialized chart parsing by default. Optional settings include `processing_options.forms`, `output_options.images_to_save`, and table output options.
- competitors.reducto.ai: default `tier: "agentic"`, `version: "latest"`, `expand: ["markdown", "metadata", "job_metadata"]`; reads `markdown_full`, else joins `markdown.pages[].markdown`. It has the same header/footer loss.
- Finding (fixed): LlamaParse returns each page's running header and footer in `markdown.pages[].header` and `.footer`, apart from `.markdown`. The adapter read only `.markdown`. Headers or footers were dropped on 9 of 14 pages for `agentic`, 8 for `agentic_plus` and 5 for `cost_effective`.
  - Raw (`charts_mpr_p53`, agentic): `"header": "MONETARY POLICY REPORT: JULY 2024 47"`, `"markdown": "## **Developments in the Federal Reserve’s Balance Sheet..."`.
  - Before: markdown starts at `## **Developments...`; the header and page number are gone.
  - After: `MONETARY POLICY REPORT: JULY 2024 47\n\n## **Developments...`.
  - Other drops: `"Drucksache 20/9100"` (German page), `"arXiv:1512.03385v1 [cs.CV] 10 Dec 2015"` (ResNet, agentic_plus), page-number footers on the paper pages, and `"Cat. No. 10231X | Form W-9"` (W-9).
- Test: `packages/core/test/providers.test.ts`, with the recorded response `test/fixtures/responses/llamaparse-agentic-header.json`.
- Verdict: fixed. Tier choice is a decision (section 6).

### 5.7 Datalab

- Presets: `mode` `accurate` / `balanced` / `fast`, `output_format: "markdown"`, `skip_cache: true`, page header and footer kept.
- Docs: `balanced` is the default mode and `accurate` is the highest-quality mode. Markdown is the default output.
- competitors.reducto.ai: `mode: "balanced"`, markdown, `skip_cache: true`; no header/footer options.
- Evidence: the adapter returns the top-level `markdown`. Image refs carry Datalab's own descriptions, for example `![Flowchart: Two residual block structures ...](868ef3e0..._img.jpg)`. No content is lost.
- Verdict: fair.

### 5.8 Pulse

- Preset: `{ model: "pulse-ultra-2", refine: true, figure_processing: { description: true } }`.
- Docs: `refine` is off by default and corrects tables, text and layout. `detect_selections` (checkboxes) is on by default.
- competitors.reducto.ai: passes caller config to the synchronous `/extract`; reads top-level `markdown`.
- Evidence: the adapter returns the top-level `markdown`, which includes page headers (`MONETARY POLICY REPORT: JULY 2024 47`). No content is lost.
- Finding (needs decision): the 1040 page fails with `job failed: Internal server error` when `refine: true`. It failed 2 of 2 times through the adapter. Direct calls: `refine: true` failed; without `refine` it completed, with or without figure descriptions. Pulse's server fails, not the adapter. Our key's responses show `plan_info.tier: "free"`.
- Verdict: needs decision (section 6).

### 5.9 Cohere

- Preset: `{ model: "parse-v5.0", output_format: "markdown" }`.
- Docs: `parse-v5.0` is the latest model. Input must be an image (we send the page PNG). Cohere Parse does not detect headers or footers. `finish_reason: "MAX_TOKENS"` means the output was cut off.
- competitors.reducto.ai: same model and output format, `image_url` input.
- Evidence: the adapter reads `pages[].markdown.content`. Image descriptions are kept.
- Finding (needs decision): on the W-9 and 1040 pages Cohere returned `finish_reason: "MAX_TOKENS"`. The output ends in a repeated dot leader (`. . . . . . .`, about 17,500 characters). The adapter returns this cut-off output as a success. The truncation is the vendor's, not ours.
- Verdict: needs decision (section 6).

## 6. Decisions for a human

1. LlamaParse tier: the published presets include `agentic_plus`, the best tier. Decide whether `agentic` and `cost_effective` stay in published comparisons. Also decide whether to turn on `processing_options.forms` (Agentic and Agentic Plus) for form pages.
2. Mistral image annotations: Mistral gives no text for figures unless you pay for annotations. Other vendors describe figures by default. Decide whether to add `bbox_annotation_format`.
3. Pulse `refine`: it improves quality but fails some pages on Pulse's side. Decide whether to keep it, and whether to ask Pulse about the failure. Also confirm that the free plan has the same quality as paid plans.
4. Cohere `MAX_TOKENS`: decide whether a cut-off result counts as a failure (retry or error) or as a low-scored success.
5. Textract features: the preset uses `LAYOUT` and `TABLES` only (Raunak's call). `FORMS` would add key-value pairs on form pages at extra cost.
6. Extend engine version: this PR moves the pin to `2.1.0`. Decide whether to pin future versions or to follow `latest`.

## 7. Limits that apply to every vendor

- Each vendor gets the same single page image (200 DPI, at most 2400 px). Vendors never see the source PDF's text layer, and they never see more than one page.
- One request may take at most 3 minutes, and a job is polled for at most 30 minutes. The slowest call in this audit took 133 seconds (Cohere on the 1040 page, which hit `MAX_TOKENS`). No call reached the 3-minute limit, but Cohere on long form pages comes closest.
- Textract has a concurrency cap of 10 because AWS throttles. The cap only changes speed, not results.
