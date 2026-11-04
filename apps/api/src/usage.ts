import { Data, Duration, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Env } from "./env.ts";

/** One paid call: a provider parse, a judge call, or a small-model call (page note, error locations, run title). */
export interface Usage {
  readonly kind: "provider" | "judge" | "note" | "locate" | "title";
  /** Preset id for a provider parse, model id for a model call. */
  readonly name: string;
  readonly runId?: string;
  readonly pageId?: string;
  readonly status: "ok" | "failed";
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly queueMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Logs the call to Workers Logs and writes it to the Analytics Engine dataset (`USAGE`, if bound).
 * Columns: index1 = run id; blob1..5 = kind, name, run id, page id, status;
 * double1..6 = cost USD, latency ms, queue ms, prompt tokens, completion tokens, reasoning tokens.
 */
export const recordUsage = (env: Env, usage: Usage) =>
  Effect.logInfo({ event: "usage", ...usage }).pipe(
    Effect.andThen(
      Effect.sync(() =>
        env.USAGE?.writeDataPoint({
    indexes: [usage.runId ?? ""],
    blobs: [usage.kind, usage.name, usage.runId ?? "", usage.pageId ?? "", usage.status],
    doubles: [
      usage.costUsd,
      usage.latencyMs,
      usage.queueMs ?? 0,
      usage.promptTokens ?? 0,
      usage.completionTokens ?? 0,
      usage.reasoningTokens ?? 0,
    ],
        }),
      ),
    ),
  );

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Cost and tokens from the `usage` object OpenRouter returns with every completion. */
export const openRouterUsage = (usage: unknown) => {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    costUsd: num(u.cost),
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(details.reasoning_tokens),
  };
};

const Completion = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({ message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) })) }),
    ),
  ),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.String), code: Schema.optional(Schema.Unknown) })),
  ),
  usage: Schema.optional(Schema.Unknown),
});

/** An OpenRouter call failed. The workflow step retries it. */
export class CompletionFailed extends Data.TaggedError("CompletionFailed")<{ readonly message: string }> {
  readonly retryable = true;
}

/**
 * Sends an OpenRouter chat completion and reads it. Fails on an HTTP error, on an `error` body (OpenRouter can answer
 * 200 with one, for example an upstream 429), on a body that is not a completion, and after `timeout`.
 */
export const complete = Effect.fn("openrouter.complete")(
  function* (env: Env, body: Record<string, unknown>, _timeout: Duration.Input) {
    const client = yield* HttpClient.HttpClient;
    const failed = (error: unknown) => new CompletionFailed({ message: String(error) });
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${env.JUDGE_BASE_URL}/chat/completions`).pipe(
          HttpClientRequest.bearerToken(env.JUDGE_API_KEY),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(failed));
    const text = yield* response.text.pipe(Effect.mapError(failed));
    if (response.status < 200 || response.status >= 300)
      return yield* new CompletionFailed({ message: `OpenRouter ${response.status}: ${text.slice(0, 500)}` });
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Completion))(text).pipe(Effect.mapError(failed));
    if (data.error !== undefined && data.error !== null) {
      return yield* new CompletionFailed({
        message: `OpenRouter error ${String(data.error.code ?? "")}: ${data.error.message ?? text.slice(0, 500)}`,
      });
    }
    return { content: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
  },
  (effect, _env, _body, timeout) =>
    Effect.timeoutOrElse(effect, {
      duration: timeout,
      orElse: () => Effect.fail(new CompletionFailed({ message: `OpenRouter timed out after ${String(timeout)}` })),
    }),
);
