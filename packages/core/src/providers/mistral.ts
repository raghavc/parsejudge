import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, joinNonEmpty, record, string } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

/**
 * With `table_format` set, Mistral moves each table out of the page markdown into `tables[]` and leaves a
 * `[tbl-0.html](tbl-0.html)` link in its place. Put the table back where the link is.
 */
export const pageMarkdown = (page: unknown): string => {
  const tables = new Map(array(record(page).tables).map((t) => [string(record(t).id) ?? "", string(record(t).content) ?? ""]));
  return (string(record(page).markdown) ?? "").replace(/\[([^\]]+)\]\(\1\)/g, (link, id: string) =>
    tables.has(id) ? (tables.get(id) as string) : link,
  );
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
    const pages = array(record(response.body).pages);
    return done({ markdown: joinNonEmpty(pages.map(pageMarkdown)), raw: response.body });
  }),
};
