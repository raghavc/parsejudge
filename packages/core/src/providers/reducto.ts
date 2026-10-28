import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { array, joinNonEmpty, number, record, string } from "../json.ts";
import { credential, done, failure, pending, type ParseOutput, type ProviderAdapter } from "../provider.ts";

const BASE_URL = "https://platform.reducto.ai";
const CREDIT_USD = 0.015;

const request = (key: string, req: HttpClientRequest.HttpClientRequest) => req.pipe(HttpClientRequest.bearerToken(key));

const chunks = (result: Record<string, unknown>) =>
  result.type === "url" && typeof result.url === "string"
    ? sendJson("reducto", HttpClientRequest.get(result.url)).pipe(Effect.map((response) => array(response.body)))
    : Effect.succeed(array(result.chunks));

const output = (raw: unknown) =>
  chunks(record(record(raw).result)).pipe(
    Effect.map((items): ParseOutput => {
      const credits = number(record(record(raw).usage).credits);
      return {
        markdown: joinNonEmpty(items.map((chunk) => string(record(chunk).content) ?? "")),
        raw,
        ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" } }),
      };
    }),
  );

export const reducto: ProviderAdapter = {
  id: "reducto",
  credentialKeys: ["REDUCTO_API_KEY"],
  submit: Effect.fn("reducto.submit")(function* (page, config, credentials) {
    const key = yield* credential("reducto", credentials, "REDUCTO_API_KEY");
    const response = yield* sendJson(
      "reducto",
      request(key, HttpClientRequest.post(`${BASE_URL}/parse_async`)).pipe(
        HttpClientRequest.bodyJsonUnsafe({ ...config, input: page.pdfUrl }),
      ),
    );
    const jobId = string(record(response.body).job_id);
    if (jobId === undefined) return yield* failure("reducto", "parse_async response has no job_id", true);
    return pending(jobId);
  }),
  poll: Effect.fn("reducto.poll")(function* (job, credentials) {
    const key = yield* credential("reducto", credentials, "REDUCTO_API_KEY");
    const response = yield* sendJson("reducto", request(key, HttpClientRequest.get(`${BASE_URL}/job/${job}`)));
    const body = record(response.body);
    if (body.status === "Failed") return yield* failure("reducto", `job failed: ${string(body.reason) ?? "unknown"}`);
    if (body.status !== "Completed") return Option.none();
    return Option.some(yield* output(body.result));
  }),
};
