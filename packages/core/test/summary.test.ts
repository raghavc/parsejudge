import { describe, expect, it } from "vitest";
import { type PageResult, summarize } from "../src/summary.ts";

const verdict = (presetId: string, score: number, high = false) => ({
  presetId,
  score,
  reasoning: "",
  errors: high ? [{ category: "content_omission" as const, severity: "high" as const, description: "" }] : [],
});

const ok = (pageId: string, presetId: string, score: number, extra: Partial<PageResult> = {}): PageResult => ({
  pageId,
  presetId,
  status: "succeeded",
  verdict: verdict(presetId, score),
  ...extra,
});

describe("summarize", () => {
  it("counts a failed page as a loss in head-to-head", () => {
    const summary = summarize([ok("p1", "reducto_r1", 4), { pageId: "p1", presetId: "aws_textract", status: "failed" }]);
    expect(summary.headToHead).toContainEqual({
      presetId: "reducto_r1",
      opponentId: "aws_textract",
      wins: 1,
      ties: 0,
      losses: 0,
    });
    expect(summary.presets.find((p) => p.presetId === "aws_textract")).toMatchObject({ failedPages: 1, meanScore: null });
  });

  it("reports observed cost only when every succeeded page has a provider cost", () => {
    const summary = summarize([
      ok("p1", "reducto_r1", 9, { cost: { usd: 0.01, source: "provider" } }),
      ok("p2", "reducto_r1", 9, { cost: { usd: 0.02, source: "provider" } }),
      ok("p1", "aws_textract", 7, { cost: { usd: 0.01, source: "provider" } }),
      ok("p2", "aws_textract", 7),
    ]);
    const byId = Object.fromEntries(summary.presets.map((p) => [p.presetId, p]));
    expect(byId.reducto_r1?.observedCostUsdPerPage).toBeCloseTo(0.015);
    expect(byId.aws_textract?.observedCostUsdPerPage).toBeNull();
  });

  it("marks only list-price/accuracy Pareto points", () => {
    const summary = summarize([ok("p1", "llamaparse_cost_effective", 8), ok("p1", "reducto_r1", 9), ok("p1", "aws_textract", 7)]);
    const pareto = Object.fromEntries(summary.tradeoff.map((point) => [point.presetId, point.pareto]));
    expect(pareto).toEqual({ llamaparse_cost_effective: true, reducto_r1: true, aws_textract: false });
    expect(summary.tradeoff.map((point) => point.listPriceUsdPerPage)).toEqual(
      [...summary.tradeoff.map((point) => point.listPriceUsdPerPage)].sort((a, b) => a - b),
    );
  });

  it("computes the high-severity rate with a Wilson interval", () => {
    const summary = summarize([
      { pageId: "p1", presetId: "reducto_r1", status: "succeeded", verdict: verdict("reducto_r1", 3, true) },
      ok("p2", "reducto_r1", 9),
    ]);
    const preset = summary.presets[0];
    expect(preset?.highSeverityRate).toBe(0.5);
    expect(preset?.highSeverityInterval?.low).toBeGreaterThan(0);
    expect(preset?.highSeverityInterval?.high).toBeLessThan(1);
    expect(preset?.errorCounts).toEqual({ content_omission: 1 });
  });

  it("reports latency per preset from succeeded pages only", () => {
    const summary = summarize([
      ok("p1", "reducto_r1", 9, { latencyMs: 1000, queueMs: 50_000 }),
      ok("p2", "reducto_r1", 9, { latencyMs: 3000 }),
      { pageId: "p3", presetId: "reducto_r1", status: "failed" },
    ]);
    expect(summary.presets[0]).toMatchObject({ latencyMsMean: 2000, latencyMsP50: 2000 });
  });
});
