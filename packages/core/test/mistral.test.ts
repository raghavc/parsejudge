import { describe, expect, it } from "vitest";
import { pageMarkdown } from "../src/providers/mistral.ts";

describe("pageMarkdown", () => {
  it("puts tables back in place of their links", () => {
    const page = {
      markdown: "Intro\n\n[tbl-0.html](tbl-0.html)\n\n![img-0.jpeg](img-0.jpeg)\n\n[tbl-9.html](tbl-9.html)",
      tables: [{ id: "tbl-0.html", content: "<table><tr><td>A</td></tr></table>", format: "html" }],
    };
    expect(pageMarkdown(page)).toBe(
      "Intro\n\n<table><tr><td>A</td></tr></table>\n\n![img-0.jpeg](img-0.jpeg)\n\n[tbl-9.html](tbl-9.html)",
    );
  });
});
