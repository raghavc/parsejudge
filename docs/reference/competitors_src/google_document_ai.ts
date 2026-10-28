import type { JsonValue, ProviderConfig } from "./schema";
import { HttpError, isRecord } from "./schema";
import type { Env } from "./types";

export const DEFAULT_GOOGLE_DOCUMENT_AI_LOCATION = "us";
export const DEFAULT_GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION =
  "pretrained-layout-parser-v1.6-2026-01-13";

type GoogleDocumentAiProcessorType = "layout" | "ocr";

const GOOGLE_DOCUMENT_AI_CONFIG_KEYS = new Set([
  "chunkSize",
  "enableImageAnnotation",
  "enableTableAnnotation",
  "imagelessMode",
  "includeAncestorHeadings",
  "processorType",
  "processorVersion",
]);

export function googleDocumentAiEndpoint(
  env: Env,
  config: ProviderConfig,
  projectId: string,
): string {
  const processorType = googleDocumentAiProcessorType(config);
  const processorId =
    processorType === "ocr"
      ? env.GOOGLE_DOCUMENT_AI_OCR_PROCESSOR_ID
      : env.GOOGLE_DOCUMENT_AI_PROCESSOR_ID;
  if (!processorId) {
    throw new HttpError(
      500,
      "SERVER_MISCONFIGURED",
      `Google Document AI ${processorType} processor is not configured.`,
    );
  }
  const location = env.GOOGLE_DOCUMENT_AI_LOCATION || DEFAULT_GOOGLE_DOCUMENT_AI_LOCATION;
  const processorEndpoint =
    `https://${encodeURIComponent(location)}-documentai.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/locations/${encodeURIComponent(location)}/processors/${encodeURIComponent(processorId)}` +
    (processorType === "ocr" ? "" : layoutProcessorVersionPath(config));
  return `${processorEndpoint}:process`;
}

export function buildGoogleDocumentAiRequest(
  pdfBytes: ArrayBuffer,
  config: ProviderConfig,
): Record<string, JsonValue> {
  rejectUnsupportedConfig(config);
  const request: Record<string, JsonValue> = {
    rawDocument: {
      content: arrayBufferToBase64(pdfBytes),
      mimeType: "application/pdf",
    },
  };
  if (googleDocumentAiProcessorType(config) === "ocr") {
    return { ...request, imagelessMode: true };
  }
  return {
    ...request,
    imagelessMode: booleanConfig(config, "imagelessMode", true),
    processOptions: {
      layoutConfig: {
        enableImageAnnotation: booleanConfig(config, "enableImageAnnotation", true),
        enableTableAnnotation: booleanConfig(config, "enableTableAnnotation", true),
        returnImages: false,
        returnBoundingBoxes: false,
        chunkingConfig: {
          chunkSize: integerConfig(config, "chunkSize", 1024),
          includeAncestorHeadings: booleanConfig(config, "includeAncestorHeadings", true),
        },
      },
    },
  };
}

export function googleDocumentAiMarkdown(raw: unknown): string {
  const document = isRecord(raw) && isRecord(raw.document) ? raw.document : {};
  const documentLayout = isRecord(document.documentLayout) ? document.documentLayout : {};
  const blocks = Array.isArray(documentLayout.blocks) ? documentLayout.blocks : [];
  const markdown = renderBlocks(blocks);
  if (markdown.length > 0) return markdown;
  return typeof document.text === "string" ? document.text : "";
}

function rejectUnsupportedConfig(config: ProviderConfig): void {
  const processorType = googleDocumentAiProcessorType(config);
  const supportedKeys = processorType === "ocr" ? new Set(["processorType"]) : GOOGLE_DOCUMENT_AI_CONFIG_KEYS;
  const unsupportedKeys = Object.keys(config)
    .filter((key) => !supportedKeys.has(key))
    .sort();
  if (unsupportedKeys.length === 0) return;
  throw new HttpError(
    400,
    "INVALID_CONFIG",
    `google_document_ai does not support config key(s): ${unsupportedKeys.join(", ")}.`,
    { unsupported_keys: unsupportedKeys },
  );
}

function googleDocumentAiProcessorType(config: ProviderConfig): GoogleDocumentAiProcessorType {
  const value = config.processorType ?? "layout";
  if (value === "layout" || value === "ocr") return value;
  throw invalidConfigType("processorType", "'layout' or 'ocr'");
}

function layoutProcessorVersionPath(config: ProviderConfig): string {
  const version = stringConfig(config, "processorVersion", DEFAULT_GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION);
  return `/processorVersions/${encodeURIComponent(version)}`;
}

function stringConfig(config: ProviderConfig, key: string, fallback: string): string {
  const value = config[key] ?? fallback;
  if (typeof value === "string" && value.length > 0) return value;
  throw invalidConfigType(key, "a non-empty string");
}

function booleanConfig(config: ProviderConfig, key: string, fallback: boolean): boolean {
  const value = config[key] ?? fallback;
  if (typeof value === "boolean") return value;
  throw invalidConfigType(key, "a boolean");
}

function integerConfig(config: ProviderConfig, key: string, fallback: number): number {
  const value = config[key] ?? fallback;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw invalidConfigType(key, "a positive integer");
}

function invalidConfigType(key: string, expected: string): HttpError {
  return new HttpError(400, "INVALID_CONFIG", `google_document_ai config ${key} must be ${expected}.`);
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  const chunks: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

type RenderContext = "markdown" | "tableCell";

function renderBlocks(blocks: unknown[], context: RenderContext = "markdown"): string {
  return blocks
    .map((block) => renderBlock(block, context))
    .filter((part) => part.length > 0)
    .join(context === "tableCell" ? "<br><br>" : "\n\n");
}

function renderBlock(value: unknown, context: RenderContext): string {
  if (!isRecord(value)) return "";
  if (isRecord(value.textBlock)) return renderTextBlock(value.textBlock, context);
  if (isRecord(value.tableBlock)) return renderTableBlock(value.tableBlock);
  if (isRecord(value.listBlock)) return renderListBlock(value.listBlock, context);
  if (isRecord(value.imageBlock)) return renderImageBlock(value.imageBlock, context);
  return "";
}

function renderTextBlock(block: Record<string, unknown>, context: RenderContext): string {
  const text = typeof block.text === "string" ? block.text.trim() : "";
  const children = Array.isArray(block.blocks) ? renderBlocks(block.blocks, context) : "";
  const ownText = context === "tableCell" ? escapeHtml(text) : headingMarkdown(text, block.type);
  return [ownText, children]
    .filter((part) => part.length > 0)
    .join(context === "tableCell" ? "<br><br>" : "\n\n");
}

function headingMarkdown(text: string, type: unknown): string {
  if (text.length === 0) return "";
  if (type === "title") return `# ${text}`;
  if (type === "subtitle") return `## ${text}`;
  if (typeof type !== "string" || !type.startsWith("heading-")) return text;
  const level = Number(type.slice("heading-".length));
  if (!Number.isInteger(level) || level < 1 || level > 6) return text;
  return `${"#".repeat(level)} ${text}`;
}

function renderTableBlock(block: Record<string, unknown>): string {
  const headerRows = Array.isArray(block.headerRows) ? block.headerRows : [];
  const bodyRows = Array.isArray(block.bodyRows) ? block.bodyRows : [];
  const caption = typeof block.caption === "string" && block.caption.trim() ? block.caption.trim() : null;
  const rows = [
    ...headerRows.map((row) => renderTableRow(row, "th")),
    ...bodyRows.map((row) => renderTableRow(row, "td")),
  ].filter((row) => row.length > 0);
  if (rows.length === 0) return caption ?? "";
  return ["<table>", ...(caption === null ? [] : [`<caption>${escapeHtml(caption)}</caption>`]), ...rows, "</table>"].join("\n");
}

function renderTableRow(value: unknown, cellTag: "td" | "th"): string {
  if (!isRecord(value) || !Array.isArray(value.cells)) return "";
  const cells = value.cells.map((cell) => renderTableCell(cell, cellTag)).filter((cell) => cell.length > 0);
  return cells.length > 0 ? `<tr>${cells.join("")}</tr>` : "";
}

function renderTableCell(value: unknown, cellTag: "td" | "th"): string {
  if (!isRecord(value)) return "";
  const blocks = Array.isArray(value.blocks) ? value.blocks : [];
  const content = renderBlocks(blocks, "tableCell");
  const rowSpan = positiveIntegerAttribute(value.rowSpan, "rowspan");
  const colSpan = positiveIntegerAttribute(value.colSpan, "colspan");
  return `<${cellTag}${rowSpan}${colSpan}>${content}</${cellTag}>`;
}

function positiveIntegerAttribute(value: unknown, name: string): string {
  return typeof value === "number" && Number.isInteger(value) && value > 1 ? ` ${name}="${value}"` : "";
}

function renderListBlock(block: Record<string, unknown>, context: RenderContext): string {
  const entries = Array.isArray(block.listEntries) ? block.listEntries : [];
  const ordered = block.type === "ordered";
  const contents = entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.blocks)) return [];
    const content = renderBlocks(entry.blocks, context);
    return content.length > 0 ? [content] : [];
  });
  if (context === "tableCell") {
    const tag = ordered ? "ol" : "ul";
    return contents.length > 0
      ? `<${tag}>${contents.map((content) => `<li>${content}</li>`).join("")}</${tag}>`
      : "";
  }
  return contents
    .map((content, index) => {
      const indented = content.replaceAll("\n", "\n  ");
      return `${ordered ? `${index + 1}.` : "-"} ${indented}`;
    })
    .join("\n");
}

function renderImageBlock(block: Record<string, unknown>, context: RenderContext): string {
  const annotations = isRecord(block.annotations) ? block.annotations : {};
  let text = "";
  if (typeof annotations.description === "string" && annotations.description.trim()) {
    text = annotations.description.trim();
  } else if (typeof block.imageText === "string") {
    text = block.imageText.trim();
  }
  return context === "tableCell" ? escapeHtml(text) : text;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
