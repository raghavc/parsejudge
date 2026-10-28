import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, failure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.extend.ai";
const API_VERSION = "2026-02-09";
const CREDIT_USD = 0.01;

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
        HttpClientRequest.bodyJsonUnsafe({ file: { url: page.pdfUrl }, config }),
      ),
    );
    const id = string(record(response.body).id);
    if (id === undefined) return yield* failure("extend", "parse_runs response has no id", true);
    return pending(id);
  }),
  poll: Effect.fn("extend.poll")(function* (job, credentials) {
    const key = yield* credential("extend", credentials, "EXTEND_API_KEY");
    const response = yield* sendJson("extend", request(key, HttpClientRequest.get(`${BASE_URL}/parse_runs/${job}`)));
    const body = record(response.body);
    if (body.status === "FAILED") return yield* failure("extend", `parse run failed: ${string(body.failureMessage) ?? ""}`);
    if (body.status !== "PROCESSED") return Option.none();
    const credits = number(record(body.usage).totalCredits) ?? number(record(body.usage).credits);
    return Option.some({
      markdown: joinNonEmpty(array(record(body.output).chunks).map((chunk) => string(record(chunk).content) ?? "")),
      raw: body,
      ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" as const } }),
    });
  }),
};
