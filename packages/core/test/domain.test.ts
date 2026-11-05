import { describe, expect, it } from "vitest";
import { withoutMedium } from "../src/domain.ts";

describe("withoutMedium", () => {
  it("reads a stored medium severity as low and keeps the rest", () => {
    const errors = [
      { category: "table_structure", severity: "medium", description: "Header cell split" },
      { category: "content_omission", severity: "high", description: "Footer missing" },
      { category: "figure_recall", severity: "figure_error", description: "Axis units missing" },
    ];
    expect(withoutMedium(errors)).toEqual([
      { category: "table_structure", severity: "low", description: "Header cell split" },
      errors[1],
      errors[2],
    ]);
  });

  it("passes non-arrays through", () => {
    expect(withoutMedium(null)).toBeNull();
  });
});
