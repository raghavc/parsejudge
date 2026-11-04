import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { array, joinNonEmpty, record, string } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

const Parsed = Schema.Struct({ pages: Schema.Array(Schema.Unknown) });

const blockMarkdown = (block: Record<string, unknown>): string => {
  const kind = string(block.type) ?? "";
  const body = record(block[kind]);
  if (kind === "text") return string(body.content) ?? "";
  if (kind === "table") return string(body.html) ?? "";
  if (kind === "image") return `![${string(body.description) ?? ""}]()`;
  return "";
};

const pageMarkdown = (page: Record<string, unknown>): string =>
  string(record(page.markdown).content) ?? joinNonEmpty(array(page.blocks).map((block) => blockMarkdown(record(block))));

/** Cohere Parse takes one page image per call. */
export const cohere: ProviderAdapter = {
  id: "cohere",
  credentialKeys: ["COHERE_API_KEY"],
  submit: Effect.fn("cohere.submit")(function* (page, config, credentials) {
    const key = yield* credential("cohere", credentials, "COHERE_API_KEY");
    const response = yield* sendJson(
      "cohere",
      HttpClientRequest.post("https://api.cohere.com/v2/parse").pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.bodyJsonUnsafe({ ...config, document: { type: "image_url", image_url: page.imageUrl } }),
      ),
    );
    const { pages } = yield* decodeBody("cohere", Parsed, response.body);
    return done({ markdown: joinNonEmpty(pages.map((p) => pageMarkdown(record(p)))), raw: response.body });
  }),
};
