import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ErrorCategory, type PresetVerdict, Severity } from "./domain.ts";
import { isRetryableStatus, JudgeError } from "./errors.ts";
import { httpErrorMessage, snippet } from "./http.ts";
import { findPreset } from "./presets.ts";
import { comparePrompt } from "./prompt.ts";

export const JUDGE_VERSION = "compare-v1";

export interface JudgeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high";
  readonly baseUrl: string;
  /** Called with the `usage` object of each answered judge call (OpenRouter includes cost). */
  readonly onUsage?: (usage: unknown) => void;
}

export interface JudgeInput {
  /** Stable id of the page; seeds the label shuffle. */
  readonly pageId: string;
  readonly imagePng: Uint8Array;
  /** Markdown per preset id. Needs at least one entry. */
  readonly markdownByPreset: Readonly<Record<string, string>>;
}

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Deterministic blinding: labels `parse_a`, `parse_b`, ... assigned by sha256(pageId:presetId) order. */
export const blindLabels = (pageId: string, presetIds: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const keyed = await Promise.all(presetIds.map(async (id) => ({ id, key: await sha256Hex(`${pageId}:${id}`) })));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return Object.fromEntries(keyed.map(({ id }, index) => [`parse_${String.fromCharCode(97 + index)}`, id]));
  });

/** Replaces the blind labels the judge saw (`parse_a`) with the preset labels they stand for. */
export const unblind = (text: string, labelToPreset: Readonly<Record<string, string>>) =>
  text.replace(/\bparse_[a-z]\b/g, (label) => {
    const presetId = labelToPreset[label];
    return presetId === undefined ? label : (findPreset(presetId)?.label ?? presetId);
  });

const Verdicts = Schema.Struct({
  evaluations: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      errors: Schema.Array(Schema.Struct({ category: ErrorCategory, severity: Severity, description: Schema.String })),
      reasoning: Schema.String,
      score: Schema.Number,
    }),
  ),
});

/** Bounds one judge call below the 5-minute workflow step timeout; high reasoning effort can take minutes. */
const JUDGE_TIMEOUT = "4 minutes";

const CompletionError = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  message: Schema.optional(Schema.String),
});

/** The fields read from an OpenRouter chat completion. Anything can be absent; the checks below say which is missing. */
const Completion = Schema.Struct({
  error: Schema.optional(Schema.NullOr(CompletionError)),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
        error: Schema.optional(Schema.NullOr(CompletionError)),
        message: Schema.optional(Schema.NullOr(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }))),
      }),
    ),
  ),
  usage: Schema.optional(Schema.Unknown),
});

const responseFormat = (labels: ReadonlyArray<string>) => ({
  type: "json_schema",
  json_schema: {
    name: "page_comparison",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["evaluations"],
      properties: {
        evaluations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "errors", "reasoning", "score"],
            properties: {
              label: { type: "string", enum: labels },
              errors: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["category", "severity", "description"],
                  properties: {
                    category: { type: "string", enum: ErrorCategory.literals },
                    severity: { type: "string", enum: Severity.literals },
                    description: { type: "string" },
                  },
                },
              },
              reasoning: { type: "string" },
              score: { type: "integer", minimum: 1, maximum: 10 },
            },
          },
        },
      },
    },
  },
});

const base64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** One judge call per page: all parses, blinded, scored 1-10 against the page image. */
export const judgePage = Effect.fn("judge.page")(function* (config: JudgeConfig, input: JudgeInput) {
  if (config.apiKey === undefined || config.apiKey === "") {
    return yield* new JudgeError({ retryable: false, message: "Judge API key is not set." });
  }
  const labelToPreset = yield* blindLabels(input.pageId, Object.keys(input.markdownByPreset));
  const labels = Object.keys(labelToPreset);
  const sections = labels
    .map((label) => `## ${label}\n\n\`\`\`\`text\n${input.markdownByPreset[labelToPreset[label] ?? ""] ?? ""}\n\`\`\`\``)
    .join("\n\n");
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(`${config.baseUrl}/chat/completions`).pipe(
    HttpClientRequest.bearerToken(config.apiKey),
    HttpClientRequest.bodyJsonUnsafe({
      model: config.model,
      reasoning_effort: config.reasoningEffort,
      response_format: responseFormat(labels),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: comparePrompt(sections, labels.join(", ")) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64(input.imagePng)}`, detail: "high" } },
          ],
        },
      ],
    }),
  );
  const { status, text } = yield* Effect.gen(function* () {
    const response = yield* client.execute(request);
    return { status: response.status, text: yield* response.text };
  }).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: httpErrorMessage(error) })),
    Effect.timeoutOrElse({
      duration: JUDGE_TIMEOUT,
      orElse: () => Effect.fail(new JudgeError({ retryable: true, message: `Judge request timed out after ${JUDGE_TIMEOUT}` })),
    }),
  );
  if (status !== 200) {
    return yield* new JudgeError({ retryable: isRetryableStatus(status), message: `HTTP ${status}: ${text.slice(0, 500)}` });
  }
  const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Completion))(text).pipe(
    Effect.mapError(
      (error) => new JudgeError({ retryable: true, message: `Invalid judge response: ${error.message}; body: ${snippet(text)}` }),
    ),
  );
  config.onUsage?.(body.usage);
  const choice = body.choices?.[0];
  // OpenRouter can answer 200 with an `error` object (e.g. an upstream 429), at the top level or on the choice.
  const error = body.error ?? choice?.error;
  if (error !== undefined && error !== null) {
    const code = Number(error.code);
    return yield* new JudgeError({
      retryable: Number.isNaN(code) || isRetryableStatus(code),
      message: `Judge error ${error.code}: ${String(error.message).slice(0, 500)}`,
    });
  }
  const content = choice?.message?.content;
  if (typeof content !== "string" || content === "") {
    return yield* new JudgeError({
      retryable: true,
      message: `Judge response has no message content (finish_reason ${choice?.finish_reason ?? "none"}): ${snippet(text)}`,
    });
  }
  const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Verdicts))(content).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: `Invalid judge output: ${error.message}` })),
  );
  const verdicts = new Map<string, PresetVerdict>();
  for (const evaluation of parsed.evaluations) {
    const presetId = labelToPreset[evaluation.label];
    if (presetId === undefined) continue;
    if (!Number.isInteger(evaluation.score) || evaluation.score < 1 || evaluation.score > 10) {
      return yield* new JudgeError({ retryable: true, message: `Judge score out of range: ${evaluation.score}` });
    }
    verdicts.set(presetId, {
      presetId,
      score: evaluation.score,
      reasoning: unblind(evaluation.reasoning, labelToPreset),
      errors: evaluation.errors.map((error) => ({ ...error, description: unblind(error.description, labelToPreset) })),
    });
  }
  if (verdicts.size !== labels.length) {
    return yield* new JudgeError({ retryable: true, message: "Judge did not score every parse." });
  }
  return [...verdicts.values()];
});
