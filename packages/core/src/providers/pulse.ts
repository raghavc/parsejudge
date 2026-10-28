import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { number, record, string } from "../json.ts";
import { credential, failure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://api.runpulse.com";
const CREDIT_USD = 0.015;

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
    const id = string(record(response.body).job_id);
    if (id === undefined) return yield* failure("pulse", "extract_async response has no job_id", true);
    return pending(id);
  }),
  poll: Effect.fn("pulse.poll")(function* (job, credentials) {
    const key = yield* credential("pulse", credentials, "PULSE_API_KEY");
    const response = yield* sendJson(
      "pulse",
      HttpClientRequest.get(`${BASE_URL}/job/${job}`).pipe(HttpClientRequest.setHeader("x-api-key", key)),
    );
    const body = record(response.body);
    if (body.status === "failed" || body.status === "cancelled") return yield* failure("pulse", `job ${String(body.status)}`);
    if (body.status !== "completed") return Option.none();
    let result = record(body.result);
    if (result.is_url === true && typeof result.url === "string") {
      result = record((yield* sendJson("pulse", HttpClientRequest.get(result.url))).body);
    }
    const credits = number(result.credits_used);
    return Option.some({
      markdown: string(result.markdown) ?? "",
      raw: body,
      ...(credits === undefined ? {} : { reportedCost: { usd: credits * CREDIT_USD, source: "provider" as const } }),
    });
  }),
};
