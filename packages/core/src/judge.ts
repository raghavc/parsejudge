import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ErrorCategory, type PresetVerdict, Severity } from "./domain.ts";
import { JudgeError } from "./errors.ts";
import { comparePrompt } from "./prompt.ts";

export const JUDGE_VERSION = "compare-v2";

export interface JudgeConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly reasoningEffort: "low" | "medium" | "high";
  readonly baseUrl: string;
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

const Verdicts = Schema.Struct({
  evaluations: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      errors: Schema.Array(
        Schema.Struct({
          category: ErrorCategory,
          severity: Severity,
          description: Schema.String,
          quotes: Schema.Array(Schema.String),
        }),
      ),
      reasoning: Schema.String,
      score: Schema.Number,
    }),
  ),
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
                  required: ["category", "severity", "description", "quotes"],
                  properties: {
                    category: { type: "string", enum: ErrorCategory.literals },
                    severity: { type: "string", enum: Severity.literals },
                    description: { type: "string" },
                    quotes: { type: "array", items: { type: "string" } },
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
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((error) => new JudgeError({ retryable: true, message: error.message })));
  const text = yield* response.text.pipe(Effect.mapError((error) => new JudgeError({ retryable: true, message: error.message })));
  if (response.status !== 200) {
    const retryable = response.status === 429 || response.status >= 500;
    return yield* new JudgeError({ retryable, message: `HTTP ${response.status}: ${text.slice(0, 500)}` });
  }
  const content = yield* Effect.try({
    try: () => String(JSON.parse(text).choices[0].message.content),
    catch: () => new JudgeError({ retryable: true, message: "Judge response has no message content." }),
  });
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
    verdicts.set(presetId, { presetId, score: evaluation.score, reasoning: evaluation.reasoning, errors: evaluation.errors });
  }
  if (verdicts.size !== labels.length) {
    return yield* new JudgeError({ retryable: true, message: "Judge did not score every parse." });
  }
  return [...verdicts.values()];
});
