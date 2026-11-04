import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { joinNonEmpty } from "../json.ts";
import { credential, done, type ProviderAdapter } from "../provider.ts";

const Ocr = Schema.Struct({ pages: Schema.Array(Schema.Struct({ markdown: Schema.String })) });

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
    return done({ markdown: joinNonEmpty(pages.map((p) => p.markdown)), raw: response.body });
  }),
};
