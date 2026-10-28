import type { Env } from "./env.ts";

/** Share of the judge key's spend limit at which on-call is paged. */
const ALERT_AT = 0.8;

interface KeyStatus {
  readonly limit: number | null;
  readonly limit_remaining: number | null;
  readonly limit_reset: string | null;
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
export const checkJudgeBudget = async (env: Env): Promise<void> => {
  if (env.BUDGET_ALERT_URL === undefined || env.BUDGET_ALERT_URL === "") return;
  const response = await fetch(`${env.JUDGE_BASE_URL}/key`, {
    headers: { authorization: `Bearer ${env.JUDGE_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Judge key status returned ${response.status}`);
  const { data } = (await response.json()) as { data: KeyStatus };
  if (data.limit === null || data.limit <= 0 || data.limit_remaining === null) return;
  const used = data.limit - data.limit_remaining;
  if (used < data.limit * ALERT_AT) return;
  const alert = await fetch(env.BUDGET_ALERT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: `ParseJudge judge key at ${Math.round((used / data.limit) * 100)}% of its ${data.limit_reset ?? ""} limit`.replace(
        "  ",
        " ",
      ),
      description: `Spent $${used.toFixed(2)} of $${data.limit.toFixed(2)}. When the limit is reached, pages stop being judged until it resets.`,
      status: "firing",
      deduplication_key: `parsejudge-judge-budget-${periodStart(data.limit_reset, new Date())}`,
      metadata: { used_usd: used, limit_usd: data.limit, limit_reset: data.limit_reset },
    }),
  });
  if (!alert.ok) throw new Error(`Budget alert returned ${alert.status}`);
};
