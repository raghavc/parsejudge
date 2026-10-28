import { Effect } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, joinNonEmpty, record, string } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

export const mistral: ProviderAdapter = {
  id: "mistral_ocr",
  credentialKeys: ["MISTRAL_API_KEY"],
  submit: Effect.fn("mistral.submit")(function* (page, config, credentials) {
    const key = yield* credential("mistral_ocr", credentials, "MISTRAL_API_KEY");
    const response = yield* sendJson(
      "mistral_ocr",
      HttpClientRequest.post("https://api.mistral.ai/v1/ocr").pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.bodyJsonUnsafe({ ...config, document: { type: "document_url", document_url: page.pdfUrl } }),
      ),
    );
    const pages = array(record(response.body).pages);
    return done({ markdown: joinNonEmpty(pages.map((p) => string(record(p).markdown) ?? "")), raw: response.body });
  }),
};
