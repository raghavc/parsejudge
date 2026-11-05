import { Data, Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Env } from "./env.ts";

/** Share of the judge key's spend limit at which on-call is paged. */
const ALERT_AT = 0.8;

/** OpenRouter `GET /key`; only the fields the alert reads. */
const KeyStatus = Schema.Struct({
  data: Schema.Struct({
    limit: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_remaining: Schema.optional(Schema.NullOr(Schema.Number)),
    limit_reset: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** The budget check failed; the workflow step retries it. */
class BudgetCheckFailed extends Data.TaggedError("BudgetCheckFailed")<{ readonly message: string }> {
  readonly retryable = true;
}

/** Start of the key's current limit period, so each period pages at most once. */
const periodStart = (reset: string | null, now: Date): string => {
  const day = now.toISOString().slice(0, 10);
  if (reset === "daily") return day;
  if (reset === "monthly") return day.slice(0, 7);
  if (reset === "weekly") {
    const monday = new Date(now);
    monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  return "total";
};

/**
 * Reads the judge key's spend from OpenRouter and sends an incident.io HTTP alert when it passes
 * ALERT_AT of the limit. Runs after every run, because spend only grows when runs do.
 */
export const checkJudgeBudget = Effect.fn("checkJudgeBudget")(function* (env: Env) {
  const alertUrl = env.BUDGET_ALERT_URL;
  if (alertUrl === undefined || alertUrl === "") return;
  const client = yield* HttpClient.HttpClient;
  const failed = (error: unknown) => new BudgetCheckFailed({ message: String(error) });
  const response = yield* client
    .execute(HttpClientRequest.get(`${env.JUDGE_BASE_URL}/key`).pipe(HttpClientRequest.bearerToken(env.JUDGE_API_KEY)))
    .pipe(Effect.mapError(failed));
  if (response.status < 200 || response.status >= 300)
    return yield* new BudgetCheckFailed({ message: `Judge key status returned ${response.status}` });
  const { data } = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(KeyStatus)), Effect.mapError(failed));
  if (data.limit == null || data.limit <= 0 || data.limit_remaining == null) return;
  const used = data.limit - data.limit_remaining;
  if (used < data.limit * ALERT_AT) return;
  const alert = yield* client
    .execute(
      HttpClientRequest.post(alertUrl).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          title:
            `ParseJudge judge key at ${Math.round((used / data.limit) * 100)}% of its ${data.limit_reset ?? ""} limit`.replace(
              "  ",
              " ",
            ),
          description: `Spent $${used.toFixed(2)} of $${data.limit.toFixed(2)}. When the limit is reached, pages stop being judged until it resets.`,
          status: "firing",
          deduplication_key: `parsejudge-judge-budget-${periodStart(data.limit_reset ?? null, new Date())}`,
          metadata: { used_usd: used, limit_usd: data.limit, limit_reset: data.limit_reset ?? null },
        }),
      ),
    )
    .pipe(Effect.mapError(failed));
  if (alert.status < 200 || alert.status >= 300)
    return yield* new BudgetCheckFailed({ message: `Budget alert returned ${alert.status}` });
});
