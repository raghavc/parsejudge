import { describe, expect, it } from "vitest";
import { openRouterUsage, recordUsage } from "../src/usage.ts";

describe("usage", () => {
  it("reads cost and tokens from an OpenRouter usage object, and zeros when it is missing", () => {
    expect(
      openRouterUsage({
        cost: 0.05,
        prompt_tokens: 1200,
        completion_tokens: 300,
        completion_tokens_details: { reasoning_tokens: 200 },
      }),
    ).toEqual({ costUsd: 0.05, promptTokens: 1200, completionTokens: 300, reasoningTokens: 200 });
    expect(openRouterUsage(undefined)).toEqual({ costUsd: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });
  });

  it("writes one data point indexed by run, with cost first", () => {
    const points: Array<unknown> = [];
    const env = { USAGE: { writeDataPoint: (point: unknown) => points.push(point) } } as never;
    recordUsage(env, {
      kind: "judge",
      name: "openai/gpt-6.1-sol",
      runId: "r",
      pageId: "p",
      status: "ok",
      costUsd: 0.05,
      latencyMs: 900,
    });
    expect(points).toEqual([
      { indexes: ["r"], blobs: ["judge", "openai/gpt-6.1-sol", "r", "p", "ok"], doubles: [0.05, 900, 0, 0, 0, 0] },
    ]);
  });
});
