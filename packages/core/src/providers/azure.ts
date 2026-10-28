import { Effect, Option } from "effect";
import { HttpClientRequest } from "effect/http";
import { sendJson } from "../http.ts";
import { record, string } from "../json.ts";
import { credential, failure, pending, type ProviderAdapter } from "../provider.ts";

const API_VERSION = "2024-11-30";

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
        HttpClientRequest.bodyJsonUnsafe({ urlSource: page.pdfUrl }),
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
    const body = record(response.body);
    if (body.status === "failed" || body.status === "canceled") {
      return yield* failure("azure_document_intelligence", `analysis ${String(body.status)}`);
    }
    if (body.status !== "succeeded") return Option.none();
    return Option.some({ markdown: string(record(body.analyzeResult).content) ?? "", raw: body });
  }),
};

