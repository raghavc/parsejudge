import { AwsClient } from "aws4fetch";
import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, bytesToBase64, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

type Block = Record<string, unknown>;

const HEADINGS: Readonly<Record<string, string>> = { LAYOUT_TITLE: "# ", LAYOUT_SECTION_HEADER: "## " };

const childIds = (block: Block): ReadonlyArray<string> =>
  array(block.Relationships)
    .map(record)
    .filter((relationship) => relationship.Type === "CHILD")
    .flatMap((relationship) => array(relationship.Ids).flatMap((id) => (typeof id === "string" ? [id] : [])));

const blockText = (block: Block, byId: ReadonlyMap<string, Block>): string => {
  const own = string(block.Text);
  if (own !== undefined && own.trim().length > 0) return own.trim();
  return childIds(block)
    .flatMap((id) => {
      const child = byId.get(id);
      if (child === undefined) return [];
      if (child.BlockType === "SELECTION_ELEMENT") return [child.SelectionStatus === "SELECTED" ? "☒" : "☐"];
      return [blockText(child, byId)];
    })
    .filter((text) => text.length > 0)
    .join(" ");
};

const tableHtml = (table: Block, byId: ReadonlyMap<string, Block>): string => {
  const rows = new Map<number, Array<string>>();
  for (const id of childIds(table)) {
    const cell = byId.get(id);
    if (cell === undefined || cell.BlockType !== "CELL") continue;
    const row = number(cell.RowIndex) ?? 0;
    const span = (name: string) => (number(cell[name]) ?? 1) > 1 ? ` ${name === "RowSpan" ? "rowspan" : "colspan"}="${number(cell[name])}"` : "";
    const cells = rows.get(row) ?? [];
    cells.push(`<td${span("RowSpan")}${span("ColumnSpan")}>${blockText(cell, byId)}</td>`);
    rows.set(row, cells);
  }
  const body = [...rows.entries()].sort(([a], [b]) => a - b).map(([, cells]) => `<tr>${cells.join("")}</tr>`);
  return `<table>${body.join("")}</table>`;
};

/** Renders Textract LAYOUT blocks in reading order; LAYOUT_TABLE blocks use the matching TABLE block. */
export const textractMarkdown = (raw: unknown): string => {
  const blocks = array(record(raw).Blocks).map(record);
  const byId = new Map(blocks.flatMap((block) => (typeof block.Id === "string" ? [[block.Id, block] as const] : [])));
  const tables = blocks.filter((block) => block.BlockType === "TABLE");
  let tableIndex = 0;
  const parts = blocks
    .filter((block) => string(block.BlockType)?.startsWith("LAYOUT_") === true)
    .map((block) => {
      const type = string(block.BlockType) ?? "";
      if (type === "LAYOUT_TABLE") {
        const table = tables[tableIndex++];
        return table === undefined ? blockText(block, byId) : tableHtml(table, byId);
      }
      if (type === "LAYOUT_PAGE_NUMBER") return "";
      return `${HEADINGS[type] ?? ""}${blockText(block, byId)}`;
    });
  return joinNonEmpty(parts);
};

export const textract: ProviderAdapter = {
  id: "aws_textract",
  credentialKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  submit: Effect.fn("textract.submit")(function* (page, config, credentials) {
    const accessKeyId = yield* credential("aws_textract", credentials, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = yield* credential("aws_textract", credentials, "AWS_SECRET_ACCESS_KEY");
    const region = credentials.AWS_REGION ?? "us-west-2";
    const bytes = yield* page.pdf;
    const url = `https://textract.${region}.amazonaws.com/`;
    const body = JSON.stringify({ Document: { Bytes: bytesToBase64(bytes) }, FeatureTypes: config.featureTypes });
    const signed = yield* Effect.promise(() =>
      new AwsClient({ accessKeyId, secretAccessKey, region, service: "textract" }).sign(url, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Textract.AnalyzeDocument" },
        body,
      }),
    );
    const response = yield* sendJson(
      "aws_textract",
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(Object.fromEntries(signed.headers.entries())),
        HttpClientRequest.bodyText(body, "application/x-amz-json-1.1"),
      ),
    );
    return done({ markdown: textractMarkdown(response.body), raw: response.body });
  }),
};
