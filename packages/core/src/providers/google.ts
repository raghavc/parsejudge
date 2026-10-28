import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { bytesToBase64, isRecord, record, string } from "../json.ts";
import { credential, done, failure, type ProviderAdapter } from "../provider.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const base64Url = (bytes: Uint8Array): string => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const base64UrlJson = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

const pemBytes = (pem: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (char) => char.charCodeAt(0));

/** Exchanges a service-account key for an OAuth access token (JWT bearer grant). */
const accessToken = Effect.fn("google.accessToken")(function* (serviceAccountJson: string) {
  const account = yield* Effect.try({
    try: () => record(JSON.parse(serviceAccountJson)),
    catch: () => failure("google_document_ai", "GOOGLE_APPLICATION_CREDENTIALS is not valid JSON"),
  });
  const email = string(account.client_email);
  const privateKey = string(account.private_key);
  if (email === undefined || privateKey === undefined) {
    return yield* failure("google_document_ai", "service account JSON needs client_email and private_key");
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        pemBytes(privateKey),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
    },
    catch: () => failure("google_document_ai", "could not sign service account JWT"),
  });
  const response = yield* sendJson(
    "google_document_ai",
    HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${base64Url(signature)}`,
      }),
    ),
  );
  const token = string(record(response.body).access_token);
  if (token === undefined) return yield* failure("google_document_ai", "token response has no access_token", true);
  return token;
});

export const googleDocumentAi: ProviderAdapter = {
  id: "google_document_ai",
  credentialKeys: [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_DOCUMENT_AI_PROJECT_ID",
    "GOOGLE_DOCUMENT_AI_LOCATION",
    "GOOGLE_DOCUMENT_AI_PROCESSOR_ID",
  ],
  submit: Effect.fn("google.submit")(function* (page, config, credentials) {
    const serviceAccount = yield* credential("google_document_ai", credentials, "GOOGLE_APPLICATION_CREDENTIALS");
    const project = yield* credential("google_document_ai", credentials, "GOOGLE_DOCUMENT_AI_PROJECT_ID");
    const processor = yield* credential("google_document_ai", credentials, "GOOGLE_DOCUMENT_AI_PROCESSOR_ID");
    const location = credentials.GOOGLE_DOCUMENT_AI_LOCATION ?? "us";
    const version = string(config.processorVersion) ?? "pretrained-layout-parser-v1.6-2026-01-13";
    const token = yield* accessToken(serviceAccount);
    const bytes = yield* page.pdf;
    const url =
      `https://${location}-documentai.googleapis.com/v1/projects/${project}/locations/${location}` +
      `/processors/${processor}/processorVersions/${version}:process`;
    const response = yield* sendJson(
      "google_document_ai",
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({
          rawDocument: { content: bytesToBase64(bytes), mimeType: "application/pdf" },
          imagelessMode: true,
          processOptions: {
            layoutConfig: {
              enableTableAnnotation: config.enableTableAnnotation === true,
              enableImageAnnotation: config.enableImageAnnotation === true,
              returnImages: false,
              returnBoundingBoxes: false,
            },
          },
        }),
      ),
    );
    return done({ markdown: googleDocumentAiMarkdown(response.body), raw: response.body });
  }),
};

export function googleDocumentAiMarkdown(raw: unknown): string {
  const document = record(record(raw).document);
  const blocks = Array.isArray(record(document.documentLayout).blocks) ? (record(document.documentLayout).blocks as unknown[]) : [];
  const markdown = renderBlocks(blocks);
  return markdown.length > 0 ? markdown : (string(document.text) ?? "");
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
