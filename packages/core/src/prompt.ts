/** Comparative judge prompt. Changing it changes JUDGE_VERSION; keep both in sync. */
export const comparePrompt = (
  parseSections: string,
  labels: string,
): string => `You are evaluating multiple text extractions of one PDF page. For each extraction you give a 1-10 score and list the specific parse errors it made.
The original page image is provided for reference.

The parses are blinded and shuffled. Evaluate each parse independently against the page image.

## Parses to score
${parseSections}

## Instructions
Evaluate each extracted text against the page image.
Score each parse from 1 (completely wrong or empty) to 10 (perfect extraction).

Here is what you should take into account:

### Text fidelity:
- Stay faithful to the visible page text, even when it appears misspelled, abbreviated, handwritten, awkward, or like a typo. Do NOT autocorrect, normalize, or silently rewrite page text while judging.
- A parse should not be penalized for preserving a visible typo or unusual spelling exactly as shown on the page. Penalize only when the extracted text differs from what is visibly present.

### Tables:
- Do the values in parsed document's cells match the right row, column label pairs visually in the document?
- Are the rows and columns accurately captured?

### Key-value pairs:
- Are the labels and values correctly paired?
- For checkbox fields, are checkboxes correctly parsed as checked or unchecked?
- Can you determine the values of each field from the parsed result?

### Semantic markers and placeholders:
- Do not penalize a parse for using explicit markers that preserve the document's semantics even if the exact marker text is not visibly printed on the page. These include provider-specific tags for blank/empty values, unchecked or checked controls, missing optional values, signature/stamp presence, illegible text, redactions, not-applicable values, or similar normalized states.
- Treat these markers as neutral formatting choices when they make the visible document state easier to recover and do not change the field, table cell, or control's meaning.
- Penalize semantic markers only when they replace visible text, attach to the wrong label or cell, create a false value/state, hide that a required value is present, or make the form/table/control structure materially harder to recover.

### Reading order and block ordering:
- For multi-column pages, text should be cleanly separated into columns, not merged into single lines. This is a catastrophic error.
- The text should read in correct reading order, like how it would be visually inferred by a human.
- Extra, repeated, or visually cluttered Markdown bullet/list markers are formatting noise when they do not change the content, reading order, or parent-child list relationships. Do NOT penalize a parse just because it has duplicated bullets such as "- -", "- o", or bullets before headings if the meaning and hierarchy remain clear.
- Penalize list-marker artifacts only when they create false checkbox states, obscure text, reorder content, flatten meaningful nesting, or make parent/sub-bullet relationships materially harder to recover.

### Figures and images:
- If the extraction includes a text description or summary of a figure, chart, or image on the page, do NOT penalize this. These are intentional figure summaries, not hallucinations or extraction errors.
- Only penalize if the description is factually wrong about what the image shows.

### Hyperlinks and embedded URLs:
- PDFs often carry hyperlink targets (e.g., mailto: addresses, https:// URLs, redirect/safelink wrappers) in a metadata layer that is not always visually rendered as text on the page.
- An extraction that surfaces these embedded URLs is NOT a hallucination -- the URL genuinely exists in the PDF's link layer.
- Treat hyperlink presence vs absence as a neutral formatting choice. Do NOT penalize OR reward an extraction based on whether it includes embedded URLs, markdown link syntax, or raw redirect strings.
- The visible anchor TEXT itself must still match the page; only the inclusion of the underlying link target is neutral.

Ignore differences in whitespace and formatting. Treat curly and straight apostrophes as equivalent.

## Errors to report
After reading the page image, list every concrete visible parse error in each parse, relative to the page image. Evaluate each parse on its own; do not use another parse as the reference. Do not invent errors if the parse is good: a perfect parse has an empty errors list. Report each distinct error once, even if it repeats across the page.

Classify each error with:
- severity: one of high, medium, or low.
  - high (materially wrong): dropped or invented content, broken table structure, a value under the wrong label, a wrong checkbox state, merged columns, broken reading order or runaway repetition. Would corrupt a downstream extraction or mislead a reader.
  - medium (real but recoverable): a real error that degrades quality but is usually recoverable in context.
  - low (minor noise): small formatting or whitespace noise that does not change the meaning or recoverability of the content.
- category: choose exactly one category from the taxonomy below. Pick the category that best describes the visible symptom, not the suspected root cause. Do not emit multiple categories for one error.
- visual_region_type: short human-readable region type, for example: table, form field, checkbox group, heading, paragraph, chart, signature block.
- location_hint: concise visual location on the page, naming the section, field label, table row and column, or nearby printed text, for example: Section B, "Police report filed?" field.
- description: one specific sentence naming what is wrong. Quote the exact page text involved and what the parse wrote instead, for example: The total reads '1,204' but the page shows '1,284'.

Use exactly one of these category values:
- \`content_omission\`: Visible content is missing from the parse.
- \`content_hallucination\`: The parse adds unsupported content, values, labels, or claims not present on
the page.
- \`text_corruption\`: Visible text is present but garbled, mistranscribed, autocorrected incorrectly, or
materially altered.
- \`text_duplication\`: Real page text is duplicated incorrectly.
- \`generation_repetition_loop\`: Output contains runaway repeated phrases, lines, sections, or markdown
blocks.
- \`reading_order\`: Content is extracted in the wrong visual or logical order.
- \`table_structure\`: Table rows, columns, headers, spans, boundaries, or grouping are structurally wrong.
- \`table_content\`: Table structure is mostly recoverable, but cell values or cell-to-row/column
assignments are wrong or missing.
- \`field_association_error\`: Visible labels, values, fields, signatures, or stamps are associated
incorrectly, such as a value under the wrong label or a signature tied to the wrong field.
- \`checkbox_state_error\`: Checkbox, radio button, selection mark, yes/no control, or similar field has
the wrong selected or checked state.
- \`header_footer\`: Header, footer, page number, repeated boilerplate, or repeated marginal content is
missing, duplicated, or incorrectly included.
- \`watermark\`: Watermark text, stamp-like background text, or diagonal/low-contrast repeated page marking
is missing, duplicated, incorrectly included, or materially misread.
- \`formatting_noise\`: Extra markup, escaping, bullets, whitespace, placeholder clutter, or formatting
artifacts materially hurt readability or recoverability.
- \`bad_figure_summary\`: Generated summary, caption, or description of a non-chart visual object is
materially wrong, unsupported, misleading, or replaces important recoverable visible content. Valid
concise faithful summaries are not errors.
- \`bad_chart_summary\`: Generated chart or graph summary, inferred table, trend statement, axis or legend
reading, or data-value reconstruction is materially wrong, unsupported, misleading, or invents precision
not visible on the page. Valid concise faithful chart summaries are not errors.
- \`visual_structure_loss\`: Diagram, map, flowchart, floorplan, visual layout, or other spatial content is
flattened so relationships, arrows, placement, grouping, or hierarchy are lost.
- \`other\`: Concrete visible parse error that does not fit the above. Use sparingly.

Use generation_repetition_loop for runaway repeated phrases, sentences, sections,
or markdown blocks caused by generation loops. Use text_duplication only for
localized duplicate extraction of real page text.

## Scoring
Decide the errors first, then score. The score must be consistent with the errors you listed: any high-severity error should keep a parse well below 10, several high-severity errors or a catastrophic one (such as merged columns or a missing section) should push it toward the bottom of the scale, and a parse with only low-severity errors can still score 9 or 10. Parses with similar errors should get similar scores.

## Output
Return JSON with:
- page_features: short tags describing the page itself, independent of any parse, for example: table, form, checkboxes, handwriting, multi-column, chart, scan, low quality.
- evaluations: exactly one evaluation per label listed here:
${labels}

For each evaluation, include the label, the list of errors as described above, concise reasoning, and the 1-10 score.
`;
