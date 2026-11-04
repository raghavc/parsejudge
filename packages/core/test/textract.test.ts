import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { textractMarkdown } from "../src/providers/textract.ts";

/** A real AnalyzeDocument response, cut down to the blocks under test. */
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`fixtures/responses/${name}`, import.meta.url), "utf8"));

const word = (id: string, text: string) => ({ Id: id, BlockType: "WORD", Text: text });
const line = (id: string, ...words: Array<string>) => ({
  Id: id,
  BlockType: "LINE",
  Relationships: [{ Type: "CHILD", Ids: words }],
});

describe("textractMarkdown", () => {
  it("renders layout titles, text and tables in reading order", () => {
    const blocks = [
      { Id: "page", BlockType: "PAGE", Relationships: [{ Type: "CHILD", Ids: ["title", "text", "layoutTable"] }] },
      { Id: "title", BlockType: "LAYOUT_TITLE", Relationships: [{ Type: "CHILD", Ids: ["l1"] }] },
      line("l1", "w1"),
      word("w1", "Invoice"),
      { Id: "text", BlockType: "LAYOUT_TEXT", Relationships: [{ Type: "CHILD", Ids: ["l2"] }] },
      line("l2", "w2", "w3"),
      word("w2", "Total"),
      word("w3", "due"),
      { Id: "layoutTable", BlockType: "LAYOUT_TABLE", Relationships: [{ Type: "CHILD", Ids: [] }] },
      { Id: "table", BlockType: "TABLE", Relationships: [{ Type: "CHILD", Ids: ["c1", "c2"] }] },
      { Id: "c1", BlockType: "CELL", RowIndex: 1, ColumnIndex: 1, Relationships: [{ Type: "CHILD", Ids: ["w4"] }] },
      { Id: "c2", BlockType: "CELL", RowIndex: 1, ColumnIndex: 2, Relationships: [{ Type: "CHILD", Ids: ["w5"] }] },
      word("w4", "Qty"),
      word("w5", "Price"),
    ];
    const markdown = textractMarkdown({ Blocks: blocks });
    expect(markdown).toContain("# Invoice");
    expect(markdown).toContain("Total due");
    expect(markdown.indexOf("# Invoice")).toBeLessThan(markdown.indexOf("Total due"));
    expect(markdown).toMatch(/<td>Qty<\/td>\s*<td>Price<\/td>/);
  });

  it("renders a list's items once, as list items, not again as a combined paragraph", () => {
    const blocks = [
      { Id: "page", BlockType: "PAGE", Relationships: [{ Type: "CHILD", Ids: ["list", "t1", "t2", "after"] }] },
      { Id: "list", BlockType: "LAYOUT_LIST", Relationships: [{ Type: "CHILD", Ids: ["t1", "t2"] }] },
      { Id: "t1", BlockType: "LAYOUT_TEXT", Relationships: [{ Type: "CHILD", Ids: ["l1"] }] },
      { Id: "t2", BlockType: "LAYOUT_TEXT", Relationships: [{ Type: "CHILD", Ids: ["l2"] }] },
      { Id: "after", BlockType: "LAYOUT_TEXT", Relationships: [{ Type: "CHILD", Ids: ["l3"] }] },
      line("l1", "w1"),
      line("l2", "w2"),
      line("l3", "w3"),
      word("w1", "Led design"),
      word("w2", "Shipped app"),
      word("w3", "Education"),
    ];
    expect(textractMarkdown({ Blocks: blocks })).toBe("- Led design\n- Shipped app\n\nEducation");
  });

  it("renders a merged header cell once, with its span (BLS Table A-1)", () => {
    const markdown = textractMarkdown(recorded("textract-merged-cells.json"));
    expect(markdown).toContain('<td rowspan="2">Employment status, sex, and age</td>');
    expect(markdown).toContain('<td colspan="3">Not seasonally adjusted</td><td colspan="6">Seasonally adjusted</td>');
  });

  it("keeps the page number (Fed Monetary Policy Report p. 47)", () => {
    expect(textractMarkdown(recorded("textract-page-number.json"))).toBe("MONETARY POLICY REPORT: JULY 2024\n\n47");
  });
});
