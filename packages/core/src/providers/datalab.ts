import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { number, record } from "../json.ts";
import { credential, jobFailure, type ProviderAdapter, pending } from "../provider.ts";

const BASE_URL = "https://www.datalab.to";

const Submitted = Schema.Struct({ request_check_url: Schema.String });
const Check = Schema.Struct({
  status: Schema.String,
  success: Schema.optional(Schema.NullOr(Schema.Boolean)),
  error: Schema.optional(Schema.NullOr(Schema.String)),
});
const Complete = Schema.Struct({ markdown: Schema.String });

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
    return pending((yield* decodeBody("datalab", Submitted, response.body)).request_check_url);
  }),
  poll: Effect.fn("datalab.poll")(function* (job, credentials) {
    const key = yield* credential("datalab", credentials, "DATALAB_API_KEY");
    const response = yield* sendJson("datalab", HttpClientRequest.get(job).pipe(HttpClientRequest.setHeader("X-Api-Key", key)));
    const check = yield* decodeBody("datalab", Check, response.body);
    if (check.status === "processing") return Option.none();
    if (check.status !== "complete" || check.success === false) {
      return yield* jobFailure("datalab", check.status, check.error, response.body);
    }
    const { markdown } = yield* decodeBody("datalab", Complete, response.body);
    const cents = number(record(record(response.body).cost_breakdown).final_cost_cents);
    return Option.some({
      markdown,
      raw: response.body,
      ...(cents === undefined ? {} : { reportedCost: { usd: cents / 100, source: "provider" as const } }),
    });
  }),
};
