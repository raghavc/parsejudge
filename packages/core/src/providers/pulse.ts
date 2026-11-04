import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { number, record } from "../json.ts";
import { credential, jobFailure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.runpulse.com";
const CREDIT_USD = 0.015;
const RUNNING = new Set(["pending", "processing"]);

const Created = Schema.Struct({ job_id: Schema.String });
const Job = Schema.Struct({ status: Schema.String, error: Schema.optional(Schema.NullOr(Schema.String)) });
const Extraction = Schema.Struct({ markdown: Schema.String });
const Completed = Schema.Struct({
  result: Schema.Union([Schema.Struct({ is_url: Schema.Literal(true), url: Schema.String }), Extraction]),
});

export const pulse: ProviderAdapter = {
  id: "pulse",
  credentialKeys: ["PULSE_API_KEY"],
  submit: Effect.fn("pulse.submit")(function* (page, config, credentials) {
    const key = yield* credential("pulse", credentials, "PULSE_API_KEY");
    const response = yield* sendJson(
      "pulse",
      HttpClientRequest.post(`${BASE_URL}/extract_async`).pipe(
        HttpClientRequest.setHeader("x-api-key", key),
        HttpClientRequest.bodyJsonUnsafe({ ...config, file_url: page.imageUrl }),
      ),
    );
    return pending((yield* decodeBody("pulse", Created, response.body)).job_id);
  }),
  poll: Effect.fn("pulse.poll")(function* (job, credentials) {
    const key = yield* credential("pulse", credentials, "PULSE_API_KEY");
    const response = yield* sendJson(
      "pulse",
      HttpClientRequest.get(`${BASE_URL}/job/${job}`).pipe(HttpClientRequest.setHeader("x-api-key", key)),
    );
    const { status, error } = yield* decodeBody("pulse", Job, response.body);
    if (RUNNING.has(status)) return Option.none();
    if (status !== "completed") return yield* jobFailure("pulse", status, error, response.body);
    const { result } = yield* decodeBody("pulse", Completed, response.body);
    let extraction: unknown = record(response.body).result;
    if ("url" in result) extraction = (yield* sendJson("pulse", HttpClientRequest.get(result.url))).body;
    const { markdown } = yield* decodeBody("pulse", Extraction, extraction);
    const credits = number(record(extraction).credits_used);
    return Option.some({
      markdown,
      raw: response.body,
      ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" as const } }),
    });
  }),
};
