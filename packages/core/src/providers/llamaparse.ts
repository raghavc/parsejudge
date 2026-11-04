import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson, snippet } from "../http.ts";
import { array, joinNonEmpty, record } from "../json.ts";
import { credential, failure, jobFailure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.cloud.llamaindex.ai/api/v2/parse";
const RUNNING = new Set(["PENDING", "RUNNING"]);

const Created = Schema.Struct({ id: Schema.String });
const Job = Schema.Struct({
  job: Schema.Struct({ status: Schema.String, error_message: Schema.optional(Schema.NullOr(Schema.String)) }),
});
/** A page that failed has `success: false` and no markdown. */
const Completed = Schema.Struct({
  markdown: Schema.Struct({
    pages: Schema.Array(Schema.Struct({ markdown: Schema.optional(Schema.String), success: Schema.optional(Schema.Boolean) })),
  }),
});

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
    return pending((yield* decodeBody("llamaparse", Created, response.body)).id);
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
    const { status, error_message } = (yield* decodeBody("llamaparse", Job, response.body)).job;
    if (RUNNING.has(status)) return Option.none();
    if (status !== "COMPLETED") return yield* jobFailure("llamaparse", status, error_message, response.body);
    const { pages } = (yield* decodeBody("llamaparse", Completed, response.body)).markdown;
    const failed = pages.findIndex((page) => page.success === false || page.markdown === undefined);
    if (failed !== -1) {
      return yield* failure("llamaparse", `page failed: ${snippet(array(record(record(response.body).markdown).pages)[failed])}`);
    }
    return Option.some({ markdown: joinNonEmpty(pages.map((p) => p.markdown ?? "")), raw: response.body });
  }),
};
