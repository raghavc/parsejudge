import { describe, expect, it } from "vitest";
import { DEFAULT_PRESET_IDS, findPreset } from "../src/presets.ts";

describe("presets", () => {
  it("leave opt-in hosted presets out of the default selection", () => {
    expect(findPreset("google_layout_parser")).toMatchObject({ hosted: true, optIn: true });
    expect(DEFAULT_PRESET_IDS).not.toContain("google_layout_parser");
    expect(DEFAULT_PRESET_IDS).toContain("aws_textract");
  });
});
