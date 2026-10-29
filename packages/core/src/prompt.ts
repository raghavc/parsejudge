/** Comparative judge prompt. Changing it changes JUDGE_VERSION; keep both in sync. */
export const comparePrompt = (
  parseSections: string,
  labels: string,
): string => `You are evaluating multiple text extractions of one PDF page.
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

Return JSON with exactly one evaluation per label listed here:
${labels}

For each evaluation, include the label, a list of specific errors found, concise reasoning, and the 1-10 score.

For each error, put in "quotes" up to 6 short excerpts copied exactly, character for character, from that parse's output where the error appears (for example the duplicated sentence, or the misread word with a few words around it). Each excerpt must be a contiguous span of the output, at most 120 characters, without Markdown or HTML syntax. Leave "quotes" empty when the error is about content that is missing from the output.
`;
