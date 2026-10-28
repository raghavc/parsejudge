import { ExtendClient } from "extend-ai";
import { LlamaCloud } from "@llamaindex/llama-cloud";
import { toFile } from "@llamaindex/llama-cloud/uploads";

import { estimateExtractCost } from "./cost";
import { datalabFetch, formValue, providerHttpError } from "./providers";
import type { Env } from "./types";
import type { ExtractProvider, ExtractResult, JsonSchema, JsonValue, ProviderConfig } from "./schema";
import { HttpError, isRecord } from "./schema";

type ExtractFn = (documentUrl: string, schema: JsonSchema, config: ProviderConfig, env: Env) => Promise<ExtractResult>;

const MAX_WAIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const PENDING_STATUSES = new Set(["PENDING", "PROCESSING", "RUNNING", "THROTTLED"]);

const extractFns: Record<ExtractProvider, ExtractFn> = {
  extend: extractExtend,
  llamaparse: extractLlama,
  datalab: extractDatalab,
};

export function extractWithProvider(
  provider: ExtractProvider,
  documentUrl: string,
  schema: JsonSchema,
  config: ProviderConfig,
  env: Env,
): Promise<ExtractResult> {
  return extractFns[provider](documentUrl, schema, config, env).catch((error: unknown) => {
    if (error instanceof HttpError) throw error;
    throw providerHttpError(provider, error);
  });
}

/**
 * Poll a vendor job until it settles or the shared deadline passes. The vendor job
 * reference is attached to every failure so a caller can resume instead of re-billing.
 */
async function pollUntilSettled<T>(jobRef: string, fetchStatus: () => Promise<T>, settled: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const value = await fetchStatus();
    if (settled(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new HttpError(504, "PROVIDER_TIMEOUT", "Extraction did not finish within the wait limit.", { job_ref: jobRef });
}

function jobFailed(vendor: string, jobRef: string, status: string, detail: string | null | undefined): HttpError {
  return new HttpError(502, "PROVIDER_ERROR", `${vendor} job ended ${status}: ${detail ?? "no detail"}.`, { job_ref: jobRef, status });
}

/** Extend nests processor options under `config`; the schema is passed through untouched (Extend requires nullable leaves). */
export function buildExtendExtractRequest(documentUrl: string, schema: JsonSchema, config: ProviderConfig) {
  const processorConfig = isRecord(config.config) ? config.config : {};
  return { ...config, config: { ...processorConfig, schema }, file: { url: documentUrl } };
}

async function extractExtend(documentUrl: string, schema: JsonSchema, config: ProviderConfig, env: Env): Promise<ExtractResult> {
  const client = new ExtendClient({ token: env.EXTEND_API_KEY });
  const created = await client.extractRuns.create(
    buildExtendExtractRequest(documentUrl, schema, config) as Parameters<typeof client.extractRuns.create>[0],
  );
  const raw = await pollUntilSettled(created.id, () => client.extractRuns.retrieve(created.id), (run) => !PENDING_STATUSES.has(run.status));
  if (raw.status !== "PROCESSED") throw jobFailed("Extend", raw.id, raw.status, raw.failureMessage ?? raw.failureReason);
  const output: unknown = raw.output;
  const result = isRecord(output) && output.value !== undefined ? (output.value as JsonValue) : null;
  return { result, cost: estimateExtractCost("extend", raw, config), raw };
}

/** LlamaExtract takes the schema inside `configuration`; the caller's config supplies tier and options. */
export function buildLlamaExtractConfiguration(schema: JsonSchema, config: ProviderConfig) {
  return { ...config, data_schema: schema };
}

async function extractLlama(documentUrl: string, schema: JsonSchema, config: ProviderConfig, env: Env): Promise<ExtractResult> {
  const client = new LlamaCloud({ apiKey: env.LLAMA_CLOUD_API_KEY });
  const download = await fetch(documentUrl);
  if (!download.ok) throw new HttpError(502, "PROVIDER_ERROR", `Document download failed with status ${download.status}.`);
  const file = await client.files.create({
    file: await toFile(download, new URL(documentUrl).pathname.split("/").pop() || "document.pdf"),
    purpose: "extract",
  });
  const job = await client.extract.create({
    file_input: file.id,
    configuration: buildLlamaExtractConfiguration(schema, config) as Parameters<typeof client.extract.create>[0]["configuration"],
  });
  const expand = ["usage", "extract_metadata", "metadata"];
  const raw = await pollUntilSettled(job.id, () => client.extract.get(job.id, { expand }), (value) => !PENDING_STATUSES.has(value.status));
  if (raw.status !== "COMPLETED") throw jobFailed("LlamaExtract", raw.id, raw.status, raw.error_message);
  // LlamaCloud returns the existing job for a repeated (document, configuration) pair; deleting the job and
  // its uploaded file keeps reruns honest and the workspace clean. Best-effort: a failed delete must not
  // discard the billed result we already hold.
  await Promise.all([client.extract.delete(job.id), client.files.delete(file.id)].map((cleanup) => cleanup.catch(() => undefined)));
  return { result: (raw.extract_result ?? null) as JsonValue, cost: estimateExtractCost("llamaparse", raw, config), raw };
}

async function extractDatalab(documentUrl: string, schema: JsonSchema, config: ProviderConfig, env: Env): Promise<ExtractResult> {
  const form = new FormData();
  const fields: ProviderConfig = { ...config, file_url: documentUrl, page_schema: schema };
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, formValue(value));
  }

  const submitted = await datalabFetch("POST", "/api/v1/extract", env, form);
  const checkUrl = isRecord(submitted) && typeof submitted.request_check_url === "string" ? submitted.request_check_url : null;
  if (!checkUrl) throw new HttpError(502, "PROVIDER_ERROR", "Datalab response did not include request_check_url.");

  const raw = await pollUntilSettled(
    checkUrl,
    async () => {
      const value = await datalabFetch("GET", checkUrl, env);
      if (!isRecord(value)) throw new HttpError(502, "PROVIDER_ERROR", "Datalab poll response was not an object.");
      return value;
    },
    (value) => value.status === "complete" || (value.success === false && value.status !== "processing"),
  );
  if (raw.status !== "complete") throw jobFailed("Datalab", checkUrl, String(raw.status), typeof raw.error === "string" ? raw.error : null);
  const extracted = raw.extraction_schema_json;
  const result = (typeof extracted === "string" ? JSON.parse(extracted) : extracted ?? null) as JsonValue;
  return { result, cost: estimateExtractCost("datalab", raw, config), raw };
}
