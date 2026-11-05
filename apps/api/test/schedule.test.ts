import { describe, expect, it } from "vitest";
import { MAX_POLLS, POLL_BUDGET_MS, pollDelayMs } from "../src/schedule.ts";

const PRESETS = 15;
const STEPS_PER_INSTANCE = 10_000;

describe("poll schedule", () => {
  it("polls every second for the first 30 s, and a slow job within 10 s", () => {
    expect(Array.from({ length: 30 }, (_, i) => pollDelayMs(i)).every((d) => d === 1000)).toBe(true);
    expect(pollDelayMs(30)).toBe(1500);
    expect(Math.max(...Array.from({ length: MAX_POLLS }, (_, i) => pollDelayMs(i)))).toBe(10_000);
  });

  it("waits the whole budget before timing out", () => {
    const waited = Array.from({ length: MAX_POLLS }, (_, i) => pollDelayMs(i)).reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(POLL_BUDGET_MS);
  });

  it("keeps a page with every preset polling to the budget under the workflow step limit", () => {
    expect(PRESETS * 2 * MAX_POLLS).toBeLessThan(STEPS_PER_INSTANCE);
  });
});
