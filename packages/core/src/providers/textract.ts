import { AwsClient } from "aws4fetch";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { array, bytesToBase64, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, done, failure, type ProviderAdapter } from "../provider.ts";

const Analyzed = Schema.Struct({ Blocks: Schema.Array(Schema.Unknown) });

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
    const span = (name: string) =>
      (number(cell[name]) ?? 1) > 1 ? ` ${name === "RowSpan" ? "rowspan" : "colspan"}="${number(cell[name])}"` : "";
    const cells = rows.get(row) ?? [];
    cells.push(`<td${span("RowSpan")}${span("ColumnSpan")}>${blockText(cell, byId)}</td>`);
    rows.set(row, cells);
  }
  const body = [...rows.entries()].sort(([a], [b]) => a - b).map(([, cells]) => `<tr>${cells.join("")}</tr>`);
  return `<table>${body.join("")}</table>`;
};

const isLayout = (block: Block | undefined): block is Block => string(block?.BlockType)?.startsWith("LAYOUT_") === true;

/**
 * Renders Textract LAYOUT blocks in reading order; LAYOUT_TABLE blocks use the matching TABLE block.
 * Only the PAGE's own layout children are top level: a LAYOUT_LIST holds its items as LAYOUT_TEXT children,
 * which are rendered once, as list items.
 */
export const textractMarkdown = (raw: unknown): string => {
  const blocks = array(record(raw).Blocks).map(record);
  const byId = new Map(blocks.flatMap((block) => (typeof block.Id === "string" ? [[block.Id, block] as const] : [])));
  const tables = blocks.filter((block) => block.BlockType === "TABLE");
  const nested = new Set(blocks.filter(isLayout).flatMap((block) => childIds(block).filter((id) => isLayout(byId.get(id)))));
  const page = blocks.find((block) => block.BlockType === "PAGE");
  const fromPage =
    page === undefined
      ? []
      : childIds(page)
          .map((id) => byId.get(id))
          .filter(isLayout);
  const top = (fromPage.length > 0 ? fromPage : blocks.filter(isLayout)).filter((block) => !nested.has(String(block.Id)));
  let tableIndex = 0;
  const parts = top.map((block) => {
    const type = string(block.BlockType) ?? "";
    if (type === "LAYOUT_TABLE") {
      const table = tables[tableIndex++];
      return table === undefined ? blockText(block, byId) : tableHtml(table, byId);
    }
    if (type === "LAYOUT_PAGE_NUMBER") return "";
    if (type === "LAYOUT_LIST") {
      const items = childIds(block)
        .map((id) => byId.get(id))
        .filter(isLayout);
      return items
        .map((item) => blockText(item, byId))
        .filter((text) => text.length > 0)
        .map((text) => `- ${text}`)
        .join("\n");
    }
    return `${HEADINGS[type] ?? ""}${blockText(block, byId)}`;
  });
  return joinNonEmpty(parts);
};

const headerRecord = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
};

export const textract: ProviderAdapter = {
  id: "aws_textract",
  credentialKeys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  // AnalyzeDocument is rate limited per account; at 100 calls at once AWS throttles about half of them.
  maxConcurrency: 10,
  submit: Effect.fn("textract.submit")(function* (page, config, credentials) {
    const accessKeyId = yield* credential("aws_textract", credentials, "AWS_ACCESS_KEY_ID");
    const secretAccessKey = yield* credential("aws_textract", credentials, "AWS_SECRET_ACCESS_KEY");
    const region = credentials.AWS_REGION ?? "us-west-2";
    const bytes = yield* page.image;
    const url = `https://textract.${region}.amazonaws.com/`;
    const body = JSON.stringify({ Document: { Bytes: bytesToBase64(bytes) }, FeatureTypes: config.featureTypes });
    const signed = yield* Effect.tryPromise({
      try: () =>
        new AwsClient({ accessKeyId, secretAccessKey, region, service: "textract" }).sign(url, {
          method: "POST",
          headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "Textract.AnalyzeDocument" },
          body,
        }),
      catch: (error) => failure("aws_textract", `Could not sign the request: ${String(error)}`),
    });
    const response = yield* sendJson(
      "aws_textract",
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headerRecord(signed.headers)),
        HttpClientRequest.bodyText(body, "application/x-amz-json-1.1"),
      ),
    );
    yield* decodeBody("aws_textract", Analyzed, response.body);
    return done({ markdown: textractMarkdown(response.body), raw: response.body });
  }),
};
