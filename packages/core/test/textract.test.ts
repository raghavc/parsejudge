import { describe, expect, it } from "vitest";
import { textractMarkdown } from "../src/providers/textract.ts";

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
});
