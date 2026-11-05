import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { joinNonEmpty, number, record } from "../json.ts";
import { credential, jobFailure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.extend.ai";
const API_VERSION = "2026-02-09";
const CREDIT_USD = 0.01;
const RUNNING = new Set(["PENDING", "PROCESSING"]);

const Created = Schema.Struct({ id: Schema.String });
const Run = Schema.Struct({
  status: Schema.String,
  failureReason: Schema.optional(Schema.NullOr(Schema.String)),
  failureMessage: Schema.optional(Schema.NullOr(Schema.String)),
});
const Processed = Schema.Struct({
  output: Schema.Struct({ chunks: Schema.Array(Schema.Struct({ content: Schema.String })) }),
});

const request = (key: string, req: HttpClientRequest.HttpClientRequest) =>
  req.pipe(HttpClientRequest.bearerToken(key), HttpClientRequest.setHeader("x-extend-api-version", API_VERSION));

export const extend: ProviderAdapter = {
  id: "extend",
  credentialKeys: ["EXTEND_API_KEY"],
  submit: Effect.fn("extend.submit")(function* (page, config, credentials) {
    const key = yield* credential("extend", credentials, "EXTEND_API_KEY");
    const response = yield* sendJson(
      "extend",
      request(key, HttpClientRequest.post(`${BASE_URL}/parse_runs`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ file: { url: page.imageUrl }, config }),
      ),
    );
    return pending((yield* decodeBody("extend", Created, response.body)).id);
  }),
  poll: Effect.fn("extend.poll")(function* (job, credentials) {
    const key = yield* credential("extend", credentials, "EXTEND_API_KEY");
    const response = yield* sendJson("extend", request(key, HttpClientRequest.get(`${BASE_URL}/parse_runs/${job}`)));
    const run = yield* decodeBody("extend", Run, response.body);
    if (RUNNING.has(run.status)) return Option.none();
    if (run.status !== "PROCESSED") {
      const error = [run.failureReason, run.failureMessage].filter(Boolean).join(": ");
      return yield* jobFailure("extend", run.status, error || undefined, response.body);
    }
    const { output } = yield* decodeBody("extend", Processed, response.body);
    const usage = record(record(response.body).usage);
    const credits = number(usage.totalCredits) ?? number(usage.credits);
    return Option.some({
      markdown: joinNonEmpty(output.chunks.map((chunk) => chunk.content)),
      raw: response.body,
      ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" as const } }),
    });
  }),
};
