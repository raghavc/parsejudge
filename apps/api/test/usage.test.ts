import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { modelUsage, recordUsage } from "../src/usage.ts";

describe("usage", () => {
  it("prices tokens at the model's list price, and zeros when the usage or price is missing", () => {
    expect(
      modelUsage("gpt-6-luna", {
        prompt_tokens: 1_000_000,
        completion_tokens: 200_000,
        prompt_tokens_details: { cached_tokens: 400_000, cache_write_tokens: 100_000 },
        completion_tokens_details: { reasoning_tokens: 50_000 },
      }),
    ).toEqual({
      costUsd: expect.closeTo(0.5 * 0.1 * 2 + 0.4 * 0.01 * 2 + 0.1 * 0.125 * 2 + 0.2 * 0.5 * 1.5, 10),
      promptTokens: 1_000_000,
      completionTokens: 200_000,
      reasoningTokens: 50_000,
    });
    expect(modelUsage("gpt-6.1-sol", { prompt_tokens: 10_000, completion_tokens: 1_000 }).costUsd).toBeCloseTo(0.03, 10);
    expect(modelUsage("unknown", { prompt_tokens: 10_000 }).costUsd).toBe(0);
    expect(modelUsage("gpt-6-luna", undefined)).toEqual({ costUsd: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });
  });

  it("writes one data point indexed by run, with cost first", () => {
    const points: Array<unknown> = [];
    const env = { USAGE: { writeDataPoint: (point: unknown) => points.push(point) } } as never;
    Effect.runSync(
      recordUsage(env, {
        kind: "judge",
        name: "openai/gpt-6.1-sol",
        runId: "r",
        pageId: "p",
        status: "ok",
        costUsd: 0.05,
        latencyMs: 900,
      }),
    );
    expect(points).toEqual([
      { indexes: ["r"], blobs: ["judge", "openai/gpt-6.1-sol", "r", "p", "ok"], doubles: [0.05, 900, 0, 0, 0, 0] },
    ]);
  });
});
