import { workloadToken } from "@parsejudge/core";
import { Data, type Duration, Effect, Schema } from "effect";
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

/** OpenAI bearer token for the ParseJudge project, from OIDC workload identity. */
export const openAIToken = (env: Env) =>
  workloadToken({
    authUrl: env.OPENAI_AUTH_URL,
    identityProviderId: env.OPENAI_IDENTITY_PROVIDER_ID,
    serviceAccountId: env.OPENAI_SERVICE_ACCOUNT_ID,
    issuer: env.OPENAI_JWT_ISSUER,
    audience: env.OPENAI_JWT_AUDIENCE,
    subject: env.OPENAI_JWT_SUBJECT,
    signingKey: env.OPENAI_SIGNING_KEY,
  });

/** OpenAI standard-tier list prices, USD per 1M tokens (platform.openai.com/docs/pricing). */
const PRICES: Readonly<
  Record<string, { readonly input: number; readonly cachedInput: number; readonly cacheWrite: number; readonly output: number }>
> = {
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, cacheWrite: 5, output: 30 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, cacheWrite: 1.75, output: 14 },
};

/** Prompts above this many input tokens are billed at 2x input and 1.5x output for the whole request. */
const LONG_CONTEXT_TOKENS = 272_000;

/** Tokens from a completion's `usage` object, and their cost at `model`'s list price (0 for an unpriced model). */
export const modelUsage = (model: string, usage: unknown) => {
  const u = (usage ?? {}) as Record<string, unknown>;
  const prompt = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const cached = num(prompt.cached_tokens);
  const cacheWrites = num(prompt.cache_write_tokens);
  const price = PRICES[model];
  const long = promptTokens > LONG_CONTEXT_TOKENS;
  const costUsd =
    price === undefined
      ? 0
      : ((Math.max(0, promptTokens - cached - cacheWrites) * price.input +
          cached * price.cachedInput +
          cacheWrites * price.cacheWrite) *
          (long ? 2 : 1) +
          completionTokens * price.output * (long ? 1.5 : 1)) /
        1_000_000;
  return { costUsd, promptTokens, completionTokens, reasoningTokens: num(details.reasoning_tokens) };
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

/** A small-model call failed. The workflow step retries it. */
export class CompletionFailed extends Data.TaggedError("CompletionFailed")<{ readonly message: string }> {
  readonly retryable = true;
}

/**
 * Sends an OpenAI chat completion and reads it. Fails on an HTTP error, on an `error` body, on a body that is not a
 * completion, and after `timeout`.
 */
export const complete = Effect.fn("openai.complete")(
  function* (env: Env, body: Record<string, unknown>, _timeout: Duration.Input) {
    const client = yield* HttpClient.HttpClient;
    const failed = (error: unknown) => new CompletionFailed({ message: String(error) });
    const token = yield* openAIToken(env).pipe(Effect.mapError((error) => new CompletionFailed({ message: error.message })));
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${env.OPENAI_BASE_URL}/chat/completions`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(failed));
    const text = yield* response.text.pipe(Effect.mapError(failed));
    if (response.status < 200 || response.status >= 300)
      return yield* new CompletionFailed({ message: `OpenAI ${response.status}: ${text.slice(0, 500)}` });
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Completion))(text).pipe(Effect.mapError(failed));
    if (data.error !== undefined && data.error !== null) {
      return yield* new CompletionFailed({
        message: `OpenAI error ${String(data.error.code ?? "")}: ${data.error.message ?? text.slice(0, 500)}`,
      });
    }
    return { content: data.choices?.[0]?.message?.content ?? "", usage: data.usage };
  },
  (effect, _env, _body, timeout) =>
    Effect.timeoutOrElse(effect, {
      duration: timeout,
      orElse: () => Effect.fail(new CompletionFailed({ message: `OpenAI timed out after ${String(timeout)}` })),
    }),
);
