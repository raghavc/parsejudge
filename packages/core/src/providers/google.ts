import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { array, bytesToBase64, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, done, failure, type ProviderAdapter } from "../provider.ts";

const PROVIDER = "google_document_ai";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const PROCESSOR_NAME = /^projects\/[^/]+\/locations\/([a-z0-9-]+)\/processors\/[^/]+(?:\/processorVersions\/[^/]+)?$/;

const ServiceAccount = Schema.fromJsonString(Schema.Struct({ client_email: Schema.String, private_key: Schema.String }));
const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number });
const Processed = Schema.Struct({ document: Schema.Struct({ text: Schema.optional(Schema.String) }) });

type Block = Record<string, unknown>;

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const heading = (type: string | undefined): string => {
  if (type === "title") return "# ";
  const level = /^heading-([1-6])$/.exec(type ?? "")?.[1];
  return level === undefined ? "" : `${"#".repeat(Number(level))} `;
};

const tableHtml = (table: Block): string => {
  const rows = (key: string, tag: string) =>
    array(table[key]).map((row) => {
      const cells = array(record(row).cells).map((value) => {
        const cell = record(value);
        const span = (name: string, attribute: string) =>
          (number(cell[name]) ?? 1) > 1 ? ` ${attribute}="${number(cell[name])}"` : "";
        const text = escapeHtml(blocksMarkdown(array(cell.blocks), " "));
        return `<${tag}${span("rowSpan", "rowspan")}${span("colSpan", "colspan")}>${text}</${tag}>`;
      });
      return `<tr>${cells.join("")}</tr>`;
    });
  const caption = string(table.caption);
  return `<table>${caption ? `<caption>${escapeHtml(caption)}</caption>` : ""}${[...rows("headerRows", "th"), ...rows("bodyRows", "td")].join("")}</table>`;
};

const blockMarkdown = (block: Block): string => {
  if (block.tableBlock !== undefined) return tableHtml(record(block.tableBlock));
  if (block.listBlock !== undefined) {
    const list = record(block.listBlock);
    return array(list.listEntries)
      .map((entry, index) => {
        const text = blocksMarkdown(array(record(entry).blocks), " ");
        return text.length === 0 ? "" : `${list.type === "ordered" ? `${index + 1}.` : "-"} ${text}`;
      })
      .filter((line) => line.length > 0)
      .join("\n");
  }
  const text = record(block.textBlock);
  const own = (string(text.text) ?? "").trim();
  const children = blocksMarkdown(array(text.blocks));
  return joinNonEmpty([own.length > 0 ? `${heading(string(text.type))}${own}` : "", children]);
};

const blocksMarkdown = (blocks: ReadonlyArray<unknown>, separator = "\n\n"): string =>
  joinNonEmpty(
    blocks.map((block) => blockMarkdown(record(block))),
    separator,
  );

/** Layout Parser output as markdown: headings by level, tables as HTML. Falls back to the OCR text for other processors. */
export const documentAiMarkdown = (body: unknown): string => {
  const document = record(record(body).document);
  const blocks = array(record(document.documentLayout).blocks);
  return blocks.length > 0 ? blocksMarkdown(blocks) : (string(document.text) ?? "").trim();
};

const base64Url = (bytes: Uint8Array | string) =>
  bytesToBase64(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes)
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const pemBytes = (pem: string) =>
  Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));

const subtle = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => failure(PROVIDER, `Could not sign the service account assertion: ${String(error)}`),
  });

const signedAssertion = Effect.fn("google.signedAssertion")(function* (clientEmail: string, privateKey: string, now: number) {
  const key = yield* subtle(() =>
    crypto.subtle.importKey("pkcs8", pemBytes(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]),
  );
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = yield* subtle(() =>
    crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`)),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
});

const tokens = new Map<string, { readonly token: string; readonly expiresAt: number }>();

/** A service-account access token, reused per isolate until a minute before it expires. */
const accessToken = Effect.fn("google.accessToken")(function* (serviceAccountJson: string) {
  const account = yield* Schema.decodeUnknownEffect(ServiceAccount)(serviceAccountJson).pipe(
    Effect.mapError(() => failure(PROVIDER, "GOOGLE_DOCAI_CREDENTIALS is not a service account key JSON")),
  );
  const now = Math.floor(Date.now() / 1000);
  const cached = tokens.get(account.client_email);
  if (cached !== undefined && cached.expiresAt - 60 > now) return cached.token;
  const assertion = yield* signedAssertion(account.client_email, account.private_key, now);
  const response = yield* sendJson(
    PROVIDER,
    HttpClientRequest.post(TOKEN_URL).pipe(
      HttpClientRequest.bodyUrlParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    ),
  );
  const token = yield* decodeBody(PROVIDER, Token, response.body);
  tokens.set(account.client_email, { token: token.access_token, expiresAt: now + token.expires_in });
  return token.access_token;
});

export const google: ProviderAdapter = {
  id: PROVIDER,
  credentialKeys: ["GOOGLE_DOCAI_CREDENTIALS", "GOOGLE_DOCAI_PROCESSOR"],
  submit: Effect.fn("google.submit")(function* (page, config, credentials) {
    const serviceAccount = yield* credential(PROVIDER, credentials, "GOOGLE_DOCAI_CREDENTIALS");
    const processor = yield* credential(PROVIDER, credentials, "GOOGLE_DOCAI_PROCESSOR");
    const location = PROCESSOR_NAME.exec(processor)?.[1];
    if (location === undefined) {
      return yield* failure(PROVIDER, "GOOGLE_DOCAI_PROCESSOR must be projects/<project>/locations/<location>/processors/<id>");
    }
    const token = yield* accessToken(serviceAccount);
    const bytes = yield* page.image;
    const response = yield* sendJson(
      PROVIDER,
      HttpClientRequest.post(`https://${location}-documentai.googleapis.com/v1/${processor}:process`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe({
          rawDocument: { content: bytesToBase64(bytes), mimeType: "image/png" },
          processOptions: config.processOptions,
        }),
      ),
    );
    yield* decodeBody(PROVIDER, Processed, response.body);
    return done({ markdown: documentAiMarkdown(response.body), raw: response.body });
  }),
};
