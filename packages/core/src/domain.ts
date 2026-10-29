import { Schema } from "effect";

export const ProviderId = Schema.Literals([
  "reducto",
  "azure_document_intelligence",
  "aws_textract",
  "mistral_ocr",
  "extend",
  "llamaparse",
  "datalab",
  "pulse",
  "cohere",
]);
export type ProviderId = typeof ProviderId.Type;

export const CostSource = Schema.Literals(["provider", "list_price"]);
export type CostSource = typeof CostSource.Type;

export const Cost = Schema.Struct({ usd: Schema.Number, source: CostSource });
export type Cost = typeof Cost.Type;

export const Severity = Schema.Literals(["not_error", "low", "medium", "high"]);
export type Severity = typeof Severity.Type;

export const ErrorCategory = Schema.Literals([
  "content_omission",
  "content_hallucination",
  "text_corruption",
  "text_duplication",
  "generation_repetition_loop",
  "reading_order",
  "table_structure",
  "table_content",
  "field_association_error",
  "checkbox_state_error",
  "header_footer",
  "watermark",
  "formatting_noise",
  "bad_figure_summary",
  "bad_chart_summary",
  "visual_structure_loss",
  "other",
]);
export type ErrorCategory = typeof ErrorCategory.Type;

export const JudgedError = Schema.Struct({
  category: ErrorCategory,
  severity: Severity,
  description: Schema.String,
});
export type JudgedError = typeof JudgedError.Type;

/** The judge's verdict for one preset on one page. */
export const PresetVerdict = Schema.Struct({
  presetId: Schema.String,
  score: Schema.Number,
  reasoning: Schema.String,
  errors: Schema.Array(JudgedError),
});
export type PresetVerdict = typeof PresetVerdict.Type;
