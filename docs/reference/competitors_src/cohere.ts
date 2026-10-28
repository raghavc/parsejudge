import type { JsonValue, ProviderConfig } from "./schema";
import { isRecord } from "./schema";

export const COHERE_PARSE_URL = "https://api.cohere.com/v2/parse";
export const COHERE_PARSE_DEFAULT_MODEL = "parse-v5.0";

interface CohereParseRequest extends Record<string, JsonValue> {
  model: JsonValue;
  output_format: JsonValue;
  document: { type: "image_url"; image_url: string };
}

/** Cohere Parse takes one page image per call; `document.url` must point at a rendered page, not a PDF. */
export function buildCohereParseRequest(imageUrl: string, config: ProviderConfig): CohereParseRequest {
  return {
    ...config,
    model: config.model ?? COHERE_PARSE_DEFAULT_MODEL,
    output_format: config.output_format ?? "markdown",
    document: { type: "image_url", image_url: imageUrl },
  };
}

export function cohereMarkdown(raw: unknown): string {
  const pages = isRecord(raw) && Array.isArray(raw.pages) ? raw.pages : [];
  return pages
    .map((page: unknown) => (isRecord(page) ? pageMarkdown(page) : ""))
    .filter((part: string) => part.length > 0)
    .join("\n\n");
}

export function cohereBilledPages(raw: unknown): number | null {
  const meta = isRecord(raw) && isRecord(raw.meta) ? raw.meta : null;
  const billed = meta && isRecord(meta.billed_units) ? meta.billed_units : null;
  if (billed && typeof billed.pages === "number") return billed.pages;
  return isRecord(raw) && Array.isArray(raw.pages) ? raw.pages.length : null;
}

function pageMarkdown(page: Record<string, unknown>): string {
  if (isRecord(page.markdown) && typeof page.markdown.content === "string") return page.markdown.content;
  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  return blocks
    .map((block: unknown) => (isRecord(block) ? blockMarkdown(block) : ""))
    .filter((part: string) => part.length > 0)
    .join("\n\n");
}

function blockMarkdown(block: Record<string, unknown>): string {
  const kind = typeof block.type === "string" ? block.type : "";
  const body = isRecord(block[kind]) ? block[kind] : {};
  if (kind === "text") return typeof body.content === "string" ? body.content : "";
  if (kind === "table") return typeof body.html === "string" ? body.html : "";
  if (kind === "image") return `![${typeof body.description === "string" ? body.description : ""}]()`;
  return "";
}
