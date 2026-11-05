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
- severity: high, low, or figure_error
- category: assign exactly one category to each error record, chosen from the taxonomy below. Pick the category that best describes the visible symptom, not the suspected root cause. A single region or block may produce multiple distinct error records. In particular, one figure may produce separate \`figure_precision\` and \`figure_recall\` records when both errors are present. Do not duplicate the same issue across categories.
- visual_region_type: short human-readable region type, for example: table, form field, checkbox group, heading, paragraph, chart, signature block.
- location_hint: concise visual location on the page, naming the section, field label, table row and column, or nearby printed text, for example: Section B, "Police report filed?" field.
- description: one concise sentence explaining the error, the category choice, and, for non-figure errors, why the severity is high or low. Quote the exact page text involved and what the parse wrote instead, for example: The total reads '1,204' but the page shows '1,284'.

### Severity:
- Use \`high\` when the error changes or obscures meaning, exact values, identities, states, associations, reading order, or structural relationships; adds plausible unsupported semantic content; or makes a meaningful region difficult to recover from the parse. High severity errors are expected to materially impact downstream use cases. Exact-sensitive content includes numbers, dates, amounts, identifiers, names, addresses, measurements, formula terms, and similar values whose exact form matters.
- Use \`low\` only when the error is localized and superficial, the intended reading remains unambiguous from the parse, and no exact-sensitive value, state, identity, association, instruction, or structural relationship changes. Examples include isolated punctuation, capitalization, spacing, styling, or obvious spelling or typographic artifacts that do not alter meaning.
- Severity reflects the consequence of the error, not its visual size. A small wrong digit may be high; a visually large but harmless artifact may be low.
- Use \`figure_error\` only with \`figure_precision\` or \`figure_recall\`. Figure errors are binary and must not receive high or low severity. Generic categories must never use \`figure_error\`.

### Error Categories:

Category notes:
- Use one primary category for each error record.
- Use the most specific applicable category before a generic category: A genuine checkbox or selection-state error is \`checkbox_state_error\`. A table row, column, header, span, merge, grouping, or alignment error is \`table_structure\`. Wrong or missing content inside an otherwise intact table cell is \`table_content\`. A wrong label-to-value association in a genuine form or key-value region is \`field_association_error\`. An error caused by visible watermark or stamp content is \`watermark\`, including when the watermark interferes with a table or paragraph.
- Missing words or punctuation inside an otherwise represented unit are \`text_corruption\`. A complete missing semantic unit is \`content_omission\`.
- A misread visible token is \`text_corruption\`. Unsupported semantic content with no visible source is \`content_hallucination\`. Stray symbols, brackets, markup, and isolated duplicated text are \`text_corruption\`, while sustained, self-perpetuating repetition is \`generation_repetition_loop\`.
- Stray symbols, brackets, markup, placeholder repetition, and duplicated text are \`text_corruption\`, not \`content_hallucination\`.
- Figure precision and recall: Judge precision and recall independently. A summary may contain both an unsupported claim and an important omission; when it does, report both \`figure_precision\` and \`figure_recall\`. A shorter correct summary is preferable to a detailed unsupported one. An invented detail is a precision error and cannot compensate for missing information. Recall is not an exhaustiveness test. Do not require every data point, minor label, decorative attribute, or optional detail. Only report recall when the omission materially affects identification or understanding. Use page context only when it is clearly tied to the figure, such as a nearby caption, label, or figure identifier.
- If a visible figure has no corresponding summary, report \`figure_recall\`, not \`content_omission\`. If its summary contains unsupported content and also omits important content, report separate \`figure_precision\` and \`figure_recall\` errors.

Use exactly one of these category values:

- \`content_omission\`: A complete visible semantic unit is missing from the parse, such as a clause, sentence, paragraph, title, standalone field or value, table, or other meaningful region. Missing content in a table cell is \`table_content\`; missing checkbox state is \`checkbox_state_error\`; and missing watermark or stamp content is \`watermark\`.
  - High when the omission removes meaning, an exact value, identity, instruction, status, state, relationship, or substantial document component, including when the parse skips an entire visible block or region.
  - Low only when the omitted unit is localized or redundant, and recoverable. Examples: punctuation, bullets, separators, minor logo/footer text, redundant labels, aesthetic or cosmetic text formatting like bolding or italicization, or decorative/nonessential visuals.

- \`content_hallucination\`: The parse adds unsupported content, values, labels, or claims not present on the page.
  - High when the unsupported content could plausibly be treated as real page information. Genuine hallucinations should usually be high.
  - Low only when the addition is clearly harmless or cosmetic, and changes no fact, value, state, identity, instruction, or relationship.

- \`text_corruption\`: Visible text is present but garbled, mistranscribed, incorrectly autocorrected or translated, split or merged incorrectly, duplicated, materially altered, or polluted by unsupported non-semantic artifacts.
  - High when meaning or exactness changes, the intended text becomes ambiguous, an exact-sensitive token is affected, or corruption or repetition makes a meaningful region difficult to use.
  - Low when the issue is surface-only punctuation, capitalization, spacing, styling, or an obvious local typo whose intended reading remains unambiguous.

- \`generation_repetition_loop\`: The parse enters a runaway generation pattern, repeating the same or nearly identical token, tag, phrase, line, or block far beyond what appears on the page. Use this category for sustained, self-perpetuating repetition, typically three or more consecutive repetitions or repetition that continues to the output boundary. A single accidental duplication is \`text_corruption\`.
  - High when the loop makes a meaningful region difficult to use, crowds out or replaces visible content, or continues until the output is truncated. Most genuine repetition loops should be high.
  - This error category should always have high severity.

- \`reading_order\`: Correct content is extracted in the wrong visual or logical order.
  - High when the ordering changes meaning, mixes unrelated sections, breaks a required sequence, or makes relationships difficult to recover.
  - Low when the order differs locally but the content remains coherent and associations remain unambiguous.
  - Do not report an error when multiple orders are equally valid for independent regions.

- \`table_structure\`: Table rows, columns, headers, spans, boundaries, merges, or grouping are structurally wrong.
  - High when values can no longer be assigned confidently to the correct row, column, header, or group, or when major table structure becomes misleading.
  - Low when the imperfection is localized and harmless, and all values and relationships remain unambiguous.

- \`table_content\`: Table structure is mostly recoverable, but cell values are wrong, missing, duplicated, mistranslated, or invented.
  - High when a number, amount, date, identifier, name, status, or other meaning-bearing cell value is wrong, missing, or mistranslated.
  - Low when the issue is surface-only or cosmetic and the intended cell value remains unambiguous.

- \`field_association_error\`: Visible labels, values, fields, signatures, or stamps are associated incorrectly, such as a value under the wrong label or a signature tied to the wrong field.
  - High when the wrong association changes identity, amount, date, status, instruction, or other semantic meaning.
  - Low when placement or grouping is imperfect but the intended label-value association remains unambiguous.
  - Do not use this category for ordinary prose, diagrams, equations, or standard tables.

- \`checkbox_state_error\`: A genuine checkbox, radio button, selection mark, yes/no control, or similar field has the wrong state, is missing, is attached to the wrong option, or is added in a way that falsely implies a selection or deselection.
  - High when the error changes a selected option, approval, eligibility, preference, status, or other meaning-bearing state.
  - Low when an extraneous or redundant control marker appears but the actual state and option association remain unambiguous.

- \`watermark\`: Watermark text, stamps, seals, overlays, diagonal repeated page marking, or stamp-like background content are missing, duplicated, interleaved into foreground content, incorrectly included, or materially misread.
  - High when the watermark or stamp is the sole reliable indicator of a meaningful status or restriction, or when its insertion makes important text, a table, or another structured region materially difficult to interpret.
  - Low when the watermark is decorative or redundant, or when its insertion is localized and foreground content remains unambiguous.

- \`figure_precision\`: A figure summary contains at least one clear claim that is wrong or unsupported by the visible figure or clearly tied page context. Examples include an incorrect figure identity or type; an invented label, value, unit, entity, or relationship; a wrong chart trend or comparison; or an incorrect diagram node, connection, or direction.

- \`figure_recall\`: A figure summary omits at least one important, visible, and legible fact needed to identify or understand the figure. Examples include omitting the main subject or takeaway; essential chart labels, units, comparisons, or trends; or the main entities, stages, connections, or outcomes of a diagram.

- \`other\`: Concrete visible parse error that does not fit the above. Use sparingly.

## Scoring
Decide the errors first, then score. The score must be consistent with the errors you listed: any high-severity error should keep a parse well below 10, several high-severity errors or a catastrophic one (such as merged columns or a missing section) should push it toward the bottom of the scale, and a parse with only low-severity errors can still score 9 or 10. Parses with similar errors should get similar scores.

## Output
Return JSON with:
- page_features: short tags describing the page itself, independent of any parse, for example: table, form, checkboxes, handwriting, multi-column, chart, scan, low quality.
- evaluations: exactly one evaluation per label listed here:
${labels}

For each evaluation, include the label, the list of errors as described above, concise reasoning, and the 1-10 score.
`;
