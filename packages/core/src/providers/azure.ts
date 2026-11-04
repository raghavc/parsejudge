import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import { decodeBody, sendJson } from "../http.ts";
import { string } from "../json.ts";
import { credential, failure, jobFailure, type ProviderAdapter, pending } from "../provider.ts";

const API_VERSION = "2024-11-30";
const RUNNING = new Set(["notStarted", "running"]);

const Operation = Schema.Struct({
  status: Schema.String,
  error: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String), message: Schema.optional(Schema.String) })),
});
const Succeeded = Schema.Struct({ analyzeResult: Schema.Struct({ content: Schema.String }) });

export const azure: ProviderAdapter = {
  id: "azure_document_intelligence",
  credentialKeys: ["AZURE_DI_ENDPOINT", "AZURE_DI_KEY"],
  submit: Effect.fn("azure.submit")(function* (page, config, credentials) {
    const endpoint = yield* credential("azure_document_intelligence", credentials, "AZURE_DI_ENDPOINT");
    const key = yield* credential("azure_document_intelligence", credentials, "AZURE_DI_KEY");
    const modelId = string(config.modelId) ?? "prebuilt-layout";
    const features = Array.isArray(config.features) ? config.features.join(",") : "";
    const url = new URL(`${endpoint.replace(/\/+$/, "")}/documentintelligence/documentModels/${modelId}:analyze`);
    url.searchParams.set("api-version", API_VERSION);
    url.searchParams.set("outputContentFormat", "markdown");
    if (features.length > 0) url.searchParams.set("features", features);
    const response = yield* sendJson(
      "azure_document_intelligence",
      HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeader("Ocp-Apim-Subscription-Key", key),
        HttpClientRequest.bodyJsonUnsafe({ urlSource: page.imageUrl }),
      ),
    );
    const operation = response.headers["operation-location"];
    if (operation === undefined) {
      return yield* failure("azure_document_intelligence", "analyze response has no operation-location", true);
    }
    return pending(operation);
  }),
  poll: Effect.fn("azure.poll")(function* (job, credentials) {
    const key = yield* credential("azure_document_intelligence", credentials, "AZURE_DI_KEY");
    const response = yield* sendJson(
      "azure_document_intelligence",
      HttpClientRequest.get(job).pipe(HttpClientRequest.setHeader("Ocp-Apim-Subscription-Key", key)),
    );
    const operation = yield* decodeBody("azure_document_intelligence", Operation, response.body);
    if (RUNNING.has(operation.status)) return Option.none();
    if (operation.status !== "succeeded") {
      const error = operation.error && `${operation.error.code ?? ""} ${operation.error.message ?? ""}`.trim();
      return yield* jobFailure("azure_document_intelligence", operation.status, error || undefined, response.body);
    }
    const result = yield* decodeBody("azure_document_intelligence", Succeeded, response.body);
    return Option.some({ markdown: result.analyzeResult.content, raw: response.body });
  }),
};
