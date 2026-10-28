from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from utils.autoeval.parse_benchmark.types import JsonObject, Provider

BenchmarkDiagnosticPromptMode = Literal["generic", "generic_v2"]
JudgeReasoningEffort = Literal["none", "low", "medium", "high", "xhigh", "max"]
DEFAULT_JUDGE_MODEL = "gpt-6.1-sol"
DEFAULT_JUDGE_REASONING_EFFORT: JudgeReasoningEffort = "xhigh"

GenericSeverity = Literal["not_error", "low", "medium", "high"]
GenericV2Severity = Literal["not_error", "low", "high", "figure_error"]
ReductoSeverity = Literal["high", "medium", "low"]
Severity = GenericSeverity | GenericV2Severity | ReductoSeverity
GenericDiagnosticCategory = Literal[
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
    "text_region_as_figure",
    "bad_figure_summary",
    "bad_chart_summary",
    "visual_structure_loss",
    "unsupported_placeholder_artifact",
    "ruled_page_as_table",
    "readable_handwriting_as_signature",
    "other",
]
GenericV2DiagnosticCategory = Literal[
    "content_omission",
    "content_hallucination",
    "text_corruption",
    "generation_repetition_loop",
    "reading_order",
    "table_structure",
    "table_content",
    "field_association_error",
    "checkbox_state_error",
    "watermark",
    "figure_precision",
    "figure_recall",
    "other",
]
ReductoDiagnosticCategory = Literal[
    "content_dropped",
    "content_hallucinated",
    "table_structure_broken",
    "key_value_or_form_field_wrong",
    "reading_order_wrong",
    "header_dropped",
    "footer_dropped",
    "signature_dropped",
    "watermark_dropped",
    "logo_or_brand_dropped",
    "text_corrupted",
    "text_duplicated",
    "generation_repetition_loop",
    "figure_summary_difference",
    "separator_or_punctuation_diff",
    "whitespace_or_marker_noise",
    "other",
]
DiagnosticCategory = (
    GenericDiagnosticCategory | GenericV2DiagnosticCategory | ReductoDiagnosticCategory
)
ReductoGeometrySubtype = Literal[
    "bad_coordinates",
    "under_segmented",
    "other",
    "",
]
ReductoVisualRegionType = Literal[
    "table",
    "key_value_form",
    "checkbox_group",
    "figure_or_diagram",
    "chart",
    "photo",
    "plain_text",
    "list",
    "header_footer",
    "signature_stamp",
    "blank_grid",
    "mixed_region",
    "unknown",
]
ReductoPageFeature = Literal[
    "table",
    "form_or_kv",
    "checkboxes",
    "multi_column",
    "dense_text",
    "figure_or_diagram",
    "photo_or_screenshot",
    "chart",
    "map_or_plan",
    "blank_grid",
    "signature_or_stamp",
    "header_footer_heavy",
    "multilingual",
    "math_or_formula",
    "cross_page_table_continuation",
]
DiagnosticOmissionScope = Literal[
    "not_applicable",
    "within_block",
    "full_region",
    "unknown",
]
DiagnosticQualitySignalType = Literal[
    "transcription_difficulty",
    "multilingual_content",
    "visible_change_tracking",
]
DiagnosticQualitySignalScope = Literal["page", "block"]
DiagnosticQualitySignalConfidence = Literal["low", "medium", "high"]


@dataclass(frozen=True, slots=True)
class ParseRunRef:
    provider: Provider
    config_id: str
    run_id: str
    run_dir: Path
    raw_dir: Path
    markdown_dir: Path
    metadata_dir: Path
    manifest: JsonObject
    config: JsonObject
    expected_sample_count: int
    completed_sample_count: int
    failure_count: int

    @property
    def complete(self) -> bool:
        return (
            self.expected_sample_count > 0
            and self.completed_sample_count >= self.expected_sample_count
            and self.failure_count == 0
        )


@dataclass(frozen=True, slots=True)
class ParseCandidate:
    provider: Provider
    config_id: str
    run_id: str
    raw_path: Path
    markdown_path: Path
    metadata_path: Path
    raw: JsonObject
    markdown: str
    metadata: JsonObject

    @property
    def empty_markdown(self) -> bool:
        return not self.markdown.strip()


class JudgeUsage(BaseModel):
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None
    reasoning_tokens: int | None = None


class JudgeCost(BaseModel):
    total_cost_usd: float | int | None = None
    input_cost_usd: float | int | None = None
    output_cost_usd: float | int | None = None
    cached_input_cost_usd: float | int | None = None
    model: str | None = None
    priority_tier: str | None = None


class ParseEvaluation(BaseModel):
    """Structured response for one blinded parse."""

    label: str = Field(description="Blinded parse label, such as parse_a.")
    errors: list[str] = Field(description="Specific extraction issues observed.")
    reasoning: str = Field(description="One to two sentence rationale before scoring.")
    score: int = Field(ge=1, le=10, description="Quality score from 1 to 10 inclusive.")


class JudgeResponse(BaseModel):
    """Structured response from the judge."""

    evaluations: list[ParseEvaluation]


class PersistedScore(BaseModel):
    provider: Provider
    config_id: str
    parse_run_id: str
    score: int
    reasoning: str
    errors: list[str]
    markdown_chars: int
    empty_markdown: bool


class ComparativeScorePayload(BaseModel):
    sample_id: str
    eval_run_id: str
    scored_at: str
    judge: dict[str, str]
    label_to_config: dict[str, str]
    parse_runs: dict[str, str]
    scores: dict[str, PersistedScore]
    judge_usage: JudgeUsage
    judge_cost: JudgeCost | None = None
    elapsed_seconds: float
    missing_labels: list[str] = Field(default_factory=list)
    extra_labels: list[str] = Field(default_factory=list)


class GenericDiagnosticError(BaseModel):
    error: str
    severity: GenericSeverity
    category: GenericDiagnosticCategory
    visual_region_type: str
    location_hint: str
    involved_block_ids: list[str]
    reasoning: str
    likely_source: str
    geometry_caused_error: bool
    geometry_issue: str
    omission_scope: DiagnosticOmissionScope = "not_applicable"
    affects_multilingual_content: bool = False


class DiagnosticQualitySignal(BaseModel):
    """Non-error page evidence retained for cleanup slicing and review."""

    signal_type: DiagnosticQualitySignalType
    scope: DiagnosticQualitySignalScope
    involved_block_ids: list[str] = Field(default_factory=list)
    confidence: DiagnosticQualitySignalConfidence
    reason_codes: list[str] = Field(default_factory=list)
    reasoning: str


class GenericDiagnosticResponse(BaseModel):
    page_features: list[str]
    errors: list[GenericDiagnosticError]
    quality_signals: list[DiagnosticQualitySignal] = Field(default_factory=list)


class _GenericV2DiagnosticErrorFields(BaseModel):
    error: str
    visual_region_type: str
    location_hint: str
    involved_block_ids: list[str]
    reasoning: str
    likely_source: str
    geometry_caused_error: bool
    geometry_issue: str


class GenericV2StandardDiagnosticError(_GenericV2DiagnosticErrorFields):
    severity: Literal["not_error", "low", "high"]
    category: Literal[
        "content_omission",
        "content_hallucination",
        "text_corruption",
        "generation_repetition_loop",
        "reading_order",
        "table_structure",
        "table_content",
        "field_association_error",
        "checkbox_state_error",
        "watermark",
        "other",
    ]


class GenericV2FigureDiagnosticError(_GenericV2DiagnosticErrorFields):
    severity: Literal["figure_error"]
    category: Literal["figure_precision", "figure_recall"]


GenericV2DiagnosticError = (
    GenericV2StandardDiagnosticError | GenericV2FigureDiagnosticError
)


class GenericV2DiagnosticResponse(BaseModel):
    page_features: list[str]
    errors: list[GenericV2DiagnosticError]


class ReductoLocalizedError(BaseModel):
    category: ReductoDiagnosticCategory
    severity: ReductoSeverity
    visual_region_type: ReductoVisualRegionType
    involved_block_ids: list[str]
    reasoning: str
    geometry_caused_error: bool
    geometry_issue: str
    geometry_subtype: ReductoGeometrySubtype


class ReductoDiagnosticResponse(BaseModel):
    page_features: list[ReductoPageFeature]
    localized_errors: list[ReductoLocalizedError]


class DiagnosticError(BaseModel):
    error: str
    severity: str
    category: str
    visual_region_type: str
    location_hint: str = ""
    involved_block_ids: list[str]
    reasoning: str
    likely_source: str = ""
    source_subtype: str = ""
    attribution_rule: str = ""
    attribution: dict[str, object] | None = None
    geometry_caused_error: bool
    geometry_issue: str
    geometry_subtype: str = ""
    omission_scope: DiagnosticOmissionScope = "not_applicable"
    affects_multilingual_content: bool = False


class DiagnosticPayload(BaseModel):
    sample_id: str
    eval_run_id: str
    diagnosed_at: str
    provider: Provider
    config_id: str
    parse_run_id: str
    page_features: list[str]
    errors: list[DiagnosticError]
    quality_signals: list[DiagnosticQualitySignal] = Field(default_factory=list)
    judge_usage: JudgeUsage
    judge_cost: JudgeCost | None = None
    elapsed_seconds: float | None
    diagnostic_prompt_mode: str = "generic"
    judge_model: str = DEFAULT_JUDGE_MODEL
    judge_reasoning_effort: JudgeReasoningEffort = DEFAULT_JUDGE_REASONING_EFFORT
