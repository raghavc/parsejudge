import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkJudgeBudget } from "../src/budget.ts";
import type { Env } from "../src/env.ts";

const env = {
  JUDGE_BASE_URL: "https://judge.test/api/v1",
  JUDGE_API_KEY: "key",
  BUDGET_ALERT_URL: "https://alerts.test/hook",
} as unknown as Env;

const stubKey = (limit: number | null, remaining: number | null) => {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/key")) {
        return Response.json({ data: { limit, limit_remaining: remaining, limit_reset: "weekly" } });
      }
      sent.push(JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)));
      return new Response(null, { status: 202 });
    }),
  );
  return sent;
};

/** FetchHttpClient over the fetch stubbed for this test. */
const withFetch = Effect.provide(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch),
  ),
);

afterEach(() => vi.unstubAllGlobals());

describe("checkJudgeBudget", () => {
  it("stays quiet below 80% of the limit", async () => {
    const sent = stubKey(1000, 201);
    await Effect.runPromise(checkJudgeBudget(env).pipe(withFetch));
    expect(sent).toHaveLength(0);
  });

  it("fires once per limit period at 80% of the limit", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T12:00:00Z"), toFake: ["Date"] });
    const sent = stubKey(1000, 150);
    await Effect.runPromise(checkJudgeBudget(env).pipe(withFetch));
    vi.useRealTimers();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ status: "firing", deduplication_key: "parsejudge-judge-budget-2026-10-26" });
    expect(String(sent[0]?.title)).toContain("85%");
  });

  it("ignores keys without a limit", async () => {
    const sent = stubKey(null, null);
    await Effect.runPromise(checkJudgeBudget(env).pipe(withFetch));
    expect(sent).toHaveLength(0);
  });
});
