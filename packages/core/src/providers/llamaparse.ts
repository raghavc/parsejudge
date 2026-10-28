import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, joinNonEmpty, record, string } from "../json.ts";
import { credential, failure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.cloud.llamaindex.ai/api/v2/parse";

export const llamaparse: ProviderAdapter = {
  id: "llamaparse",
  credentialKeys: ["LLAMA_CLOUD_API_KEY"],
  submit: Effect.fn("llamaparse.submit")(function* (page, config, credentials) {
    const key = yield* credential("llamaparse", credentials, "LLAMA_CLOUD_API_KEY");
    const response = yield* sendJson(
      "llamaparse",
      HttpClientRequest.post(BASE_URL).pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.bodyJsonUnsafe({ ...config, source_url: page.imageUrl }),
      ),
    );
    const id = string(record(response.body).id);
    if (id === undefined) return yield* failure("llamaparse", "parse response has no id", true);
    return pending(id);
  }),
  poll: Effect.fn("llamaparse.poll")(function* (job, credentials) {
    const key = yield* credential("llamaparse", credentials, "LLAMA_CLOUD_API_KEY");
    const response = yield* sendJson(
      "llamaparse",
      HttpClientRequest.get(`${BASE_URL}/${job}`).pipe(
        HttpClientRequest.bearerToken(key),
        HttpClientRequest.setUrlParam("expand", "markdown"),
      ),
    );
    const body = record(response.body);
    const status = record(body.job).status;
    if (status === "FAILED" || status === "CANCELLED") {
      return yield* failure("llamaparse", `job ${String(status)}: ${string(record(body.job).error_message) ?? ""}`);
    }
    if (status !== "COMPLETED") return Option.none();
    const pages = array(record(body.markdown).pages);
    return Option.some({ markdown: joinNonEmpty(pages.map((p) => string(record(p).markdown) ?? "")), raw: body });
  }),
};
