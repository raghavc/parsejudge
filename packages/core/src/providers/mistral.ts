import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { joinNonEmpty } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

const Page = Schema.Struct({
  markdown: Schema.String,
  tables: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, content: Schema.String }))),
});
const Ocr = Schema.Struct({ pages: Schema.Array(Page) });

/**
 * With `table_format` set, Mistral moves each table out of the page markdown into `tables[]` and leaves a
 * `[tbl-0.html](tbl-0.html)` link in its place. Put the table back where the link is.
 */
export const pageMarkdown = (page: typeof Page.Type): string => {
  const tables = new Map((page.tables ?? []).map((t) => [t.id, t.content]));
  return page.markdown.replace(/\[([^\]]+)\]\(\1\)/g, (link, id: string) => tables.get(id) ?? link);
};

export const mistral: ProviderAdapter = {
  id: "mistral_ocr",
  credentialKeys: ["MISTRAL_API_KEY"],
  submit: Effect.fn("mistral.submit")(function* (page, config, credentials) {
    const key = yield* credential("mistral_ocr", credentials, "MISTRAL_API_KEY");
    const response = yield* sendJson(
      "mistral_ocr",
      HttpClientRequest.post("https://api.mistral.ai/v1/ocr").pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.bodyJsonUnsafe({ ...config, document: { type: "image_url", image_url: page.imageUrl } }),
      ),
    );
    const { pages } = yield* decodeBody("mistral_ocr", Ocr, response.body);
    return done({ markdown: joinNonEmpty(pages.map(pageMarkdown)), raw: response.body });
  }),
};
