import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { number, record, string } from "../json.ts";
import { credential, failure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://www.datalab.to";

const formValue = (value: unknown): string =>
  typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);

export const datalab: ProviderAdapter = {
  id: "datalab",
  credentialKeys: ["DATALAB_API_KEY"],
  submit: Effect.fn("datalab.submit")(function* (page, config, credentials) {
    const key = yield* credential("datalab", credentials, "DATALAB_API_KEY");
    const form = new FormData();
    for (const [name, value] of Object.entries({ ...config, file_url: page.imageUrl })) form.set(name, formValue(value));
    const response = yield* sendJson(
      "datalab",
      HttpClientRequest.post(`${BASE_URL}/api/v1/convert`).pipe(
        HttpClientRequest.setHeader("X-Api-Key", key),
        HttpClientRequest.bodyFormData(form),
      ),
    );
    const checkUrl = string(record(response.body).request_check_url);
    if (checkUrl === undefined) return yield* failure("datalab", "convert response has no request_check_url", true);
    return pending(checkUrl);
  }),
  poll: Effect.fn("datalab.poll")(function* (job, credentials) {
    const key = yield* credential("datalab", credentials, "DATALAB_API_KEY");
    const response = yield* sendJson("datalab", HttpClientRequest.get(job).pipe(HttpClientRequest.setHeader("X-Api-Key", key)));
    const body = record(response.body);
    if (body.status === "processing") return Option.none();
    if (body.status !== "complete" || body.success === false) {
      return yield* failure("datalab", `conversion failed: ${string(body.error) ?? String(body.status)}`);
    }
    const cents = number(record(body.cost_breakdown).final_cost_cents);
    return Option.some({
      markdown: string(body.markdown) ?? "",
      raw: body,
      ...(cents === undefined ? {} : { reportedCost: { usd: cents / 100, source: "provider" as const } }),
    });
  }),
};
