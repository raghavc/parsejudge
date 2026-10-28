import { ExtendClient } from "extend-ai";
import { LlamaCloud } from "@llamaindex/llama-cloud";

import { buildCohereParseRequest, COHERE_PARSE_URL, cohereMarkdown } from "./cohere";
import { estimateCost } from "./cost";
import { googleAccessToken, googleProjectId } from "./google_auth";
import {
  buildGoogleDocumentAiRequest,
  googleDocumentAiEndpoint,
  googleDocumentAiMarkdown,
} from "./google_document_ai";
import type { Env } from "./types";
import type { ErrorDetails, JsonValue, Provider, ProviderConfig, ProviderResult } from "./schema";
import { HttpError, isRecord } from "./schema";

type ProviderFn = (documentUrl: string, config: ProviderConfig, env: Env) => Promise<ProviderResult>;

interface MistralOcrRequest extends Record<string, JsonValue> {
  model: JsonValue;
  document: {
    type: "document_url";
    document_url: string;
  };
  table_format: JsonValue;
}

interface GoogleMistralOcrRequest extends Record<string, JsonValue> {
  model: typeof GOOGLE_MISTRAL_OCR_MODEL;
  document: {
    type: "document_url";
    document_url: string;
  };
}

const GOOGLE_MISTRAL_OCR_MODEL = "mistral-ocr-2505";
const GOOGLE_MISTRAL_OCR_CONFIG_KEYS = new Set(["document", "model"]);
const DEFAULT_GCP_REGION = "us-central1";

const providerFns: Record<Provider, ProviderFn> = {
  reducto: parseReducto,
  mistral_ocr: parseMistral,
  google_mistral_ocr: parseGoogleMistral,
  google_document_ai: parseGoogleDocumentAi,
  extend: parseExtend,
  llamaparse: parseLlama,
  datalab: parseDatalab,
  pulse: parsePulse,
  cohere: parseCohere,
  azure_document_intelligence: parseAzureDocumentIntelligence,
};

export function parseWithProvider(
  provider: Provider,
  documentUrl: string,
  config: ProviderConfig,
  env: Env,
): Promise<ProviderResult> {
  return providerFns[provider](documentUrl, config, env).catch((error: unknown) => {
    if (error instanceof HttpError) throw error;
    throw providerHttpError(provider, error);
  });
}

async function parseReducto(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const response = await fetch("https://platform.reducto.ai:443/parse", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.REDUCTO_API_KEY}`,
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Port": "443",
      "X-Forwarded-Ssl": "on",
    },
    body: JSON.stringify({ ...config, input: documentUrl }),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(502, "PROVIDER_ERROR", `Reducto redirected to ${response.headers.get("location") ?? "unknown"}.`);
  }
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_ERROR", `Reducto request failed with status ${response.status}.`);
  }

  const raw = await response.json();
  const result = isRecord(raw) && isRecord(raw.result) ? raw.result : {};
  const chunks = Array.isArray(result.chunks) ? result.chunks : await reductoUrlChunks(result);
  const markdown = chunks
    .map((chunk: unknown) => (isRecord(chunk) && typeof chunk.content === "string" ? chunk.content : ""))
    .filter((content: string) => content.length > 0)
    .join("\n\n");
  return { markdown, cost: estimateCost("reducto", raw), raw };
}

async function reductoUrlChunks(result: Record<string, unknown>): Promise<unknown[]> {
  if (result.type !== "url" || typeof result.url !== "string") return [];
  const response = await fetch(result.url);
  if (!response.ok) throw new HttpError(502, "PROVIDER_ERROR", "Reducto result URL fetch failed.");
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

async function parseMistral(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const response = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildMistralOcrRequest(documentUrl, config)),
  });
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_ERROR", `Mistral OCR request failed with status ${response.status}.`);
  }

  const raw = await response.json();
  const pages = isRecord(raw) && Array.isArray(raw.pages) ? raw.pages : [];
  const markdown = pages
    .map((page: unknown) => (isRecord(page) && typeof page.markdown === "string" ? page.markdown : ""))
    .filter((part: string) => part.length > 0)
    .join("\n\n");
  return { markdown, cost: estimateCost("mistral_ocr", raw, config), raw };
}

async function parseGoogleMistral(
  documentUrl: string,
  config: ProviderConfig,
  env: Env,
): Promise<ProviderResult> {
  const request = buildGoogleMistralOcrRequest(documentUrl, config);
  const projectId = googleProjectId(env);
  const region = env.GCP_REGION || DEFAULT_GCP_REGION;
  const endpoint =
    `https://${region}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}` +
    `/locations/${encodeURIComponent(region)}/publishers/mistralai/models/${GOOGLE_MISTRAL_OCR_MODEL}:rawPredict`;
  const accessToken = await googleAccessToken(env);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw new HttpError(
      502,
      "PROVIDER_ERROR",
      `Google-hosted Mistral OCR request failed with status ${response.status}.`,
    );
  }

  const raw = await response.json();
  const pages = isRecord(raw) && Array.isArray(raw.pages) ? raw.pages : [];
  const markdown = pages
    .map((page: unknown) => (isRecord(page) && typeof page.markdown === "string" ? page.markdown : ""))
    .filter((part: string) => part.length > 0)
    .join("\n\n");
  return { markdown, cost: estimateCost("google_mistral_ocr", raw, config), raw };
}

async function parseGoogleDocumentAi(
  documentUrl: string,
  config: ProviderConfig,
  env: Env,
): Promise<ProviderResult> {
  const documentResponse = await fetch(documentUrl);
  if (!documentResponse.ok) {
    throw new HttpError(
      502,
      "DOCUMENT_FETCH_ERROR",
      `Document download failed with status ${documentResponse.status}.`,
    );
  }
  const request = buildGoogleDocumentAiRequest(await documentResponse.arrayBuffer(), config);
  const projectId = env.GOOGLE_DOCUMENT_AI_PROJECT_ID || googleProjectId(env);
  const endpoint = googleDocumentAiEndpoint(env, config, projectId);
  const temporaryAccessToken = env.GOOGLE_DOCUMENT_AI_ACCESS_TOKEN;
  const accessToken = temporaryAccessToken || (await googleAccessToken(env));
  const requestBody = JSON.stringify(request);
  const started = performance.now();
  let response = await fetchGoogleDocumentAi(endpoint, requestBody, accessToken);
  if (temporaryAccessToken && (response.status === 401 || response.status === 403)) {
    response = await fetchGoogleDocumentAi(endpoint, requestBody, await googleAccessToken(env));
  }
  if (!response.ok) {
    throw new HttpError(
      502,
      "PROVIDER_ERROR",
      `Google Document AI request failed with status ${response.status}.`,
    );
  }
  const raw = await response.json();
  return {
    markdown: googleDocumentAiMarkdown(raw),
    cost: estimateCost("google_document_ai", raw, config),
    raw,
    duration_ms: Math.round(performance.now() - started),
  };
}

function fetchGoogleDocumentAi(endpoint: string, requestBody: string, accessToken: string): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: requestBody,
  });
}

export function buildMistralOcrRequest(documentUrl: string, config: ProviderConfig): MistralOcrRequest {
  const request: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "document") continue;
    request[mistralOcrFieldName(key)] = value;
  }

  return {
    ...request,
    model: request.model ?? "mistral-ocr-latest",
    document: { type: "document_url", document_url: documentUrl },
    table_format: request.table_format ?? "html",
  };
}

export function buildGoogleMistralOcrRequest(
  documentUrl: string,
  config: ProviderConfig,
): GoogleMistralOcrRequest {
  const unsupportedKeys = Object.keys(config)
    .filter((key) => !GOOGLE_MISTRAL_OCR_CONFIG_KEYS.has(key))
    .sort();
  if (unsupportedKeys.length > 0) {
    throw new HttpError(
      400,
      "INVALID_CONFIG",
      `google_mistral_ocr does not support config key(s): ${unsupportedKeys.join(", ")}.`,
      { unsupported_keys: unsupportedKeys },
    );
  }
  return {
    model: GOOGLE_MISTRAL_OCR_MODEL,
    document: { type: "document_url", document_url: documentUrl },
  };
}

function mistralOcrFieldName(key: string): string {
  return key.replace(/[A-Z]/g, (letter: string) => `_${letter.toLowerCase()}`);
}

async function parseExtend(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const client = new ExtendClient({ token: env.EXTEND_API_KEY });
  const defaultParseConfig = { target: "markdown" };
  const overrideParseConfig = isRecord(config.config) ? config.config : {};
  const raw = await client.parseRuns.createAndPoll({
    ...config,
    config: { ...defaultParseConfig, ...overrideParseConfig },
    file: { url: documentUrl },
  } as Parameters<typeof client.parseRuns.createAndPoll>[0], {
    maxWaitMs: 30 * 60 * 1000,
    requestOptions: { timeoutInSeconds: 60 },
  });
  const chunks = raw.output?.chunks ?? [];
  const markdown = chunks.map((chunk) => chunk.content).filter((content) => content.length > 0).join("\n\n");
  return { markdown, cost: estimateCost("extend", raw), raw };
}

async function parseLlama(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const client = new LlamaCloud({ apiKey: env.LLAMA_CLOUD_API_KEY });
  const raw = await client.parsing.parse(
    {
      tier: "agentic",
      version: "latest",
      expand: ["markdown", "metadata", "job_metadata"],
      ...config,
      source_url: documentUrl,
    },
    { timeout: 300, pollingInterval: 1 },
  );
  const markdown = raw.markdown_full ?? raw.markdown?.pages.map((page) => ("markdown" in page ? page.markdown : "")).join("\n\n") ?? "";
  return { markdown, cost: estimateCost("llamaparse", raw), raw };
}

async function parseDatalab(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const form = new FormData();
  const fields: ProviderConfig = {
    output_format: "markdown",
    mode: "balanced",
    skip_cache: true,
    ...config,
    file_url: documentUrl,
  };
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, formValue(value));
  }

  const submitted = await datalabFetch("POST", "/api/v1/convert", env, form);
  const checkUrl = isRecord(submitted) && typeof submitted.request_check_url === "string" ? submitted.request_check_url : null;
  if (!checkUrl) throw new HttpError(502, "PROVIDER_ERROR", "Datalab response did not include request_check_url.");

  const raw = await pollDatalab(checkUrl, env);
  const markdown = isRecord(raw) && typeof raw.markdown === "string" ? raw.markdown : "";
  return { markdown, cost: estimateCost("datalab", raw, fields), raw };
}

const PULSE_EXTRACT_URL = "https://api.runpulse.com/extract";

async function parsePulse(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const response = await fetch(PULSE_EXTRACT_URL, {
    method: "POST",
    headers: { "x-api-key": env.PULSE_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, file_url: documentUrl }),
  });
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_ERROR", `Pulse request failed with status ${response.status}.`);
  }
  let raw: unknown = await response.json();
  if (isRecord(raw) && raw.is_url === true && typeof raw.url === "string") {
    const download = await fetch(raw.url, { headers: { "x-api-key": env.PULSE_API_KEY } });
    if (!download.ok) throw new HttpError(502, "PROVIDER_ERROR", "Pulse result URL fetch failed.");
    raw = await download.json();
  }
  const markdown = isRecord(raw) && typeof raw.markdown === "string" ? raw.markdown : "";
  return { markdown, cost: estimateCost("pulse", raw), raw };
}

async function parseCohere(documentUrl: string, config: ProviderConfig, env: Env): Promise<ProviderResult> {
  const response = await fetch(COHERE_PARSE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      "Content-Type": "application/json",
      "X-Client-Name": "reducto-competitors",
    },
    body: JSON.stringify(buildCohereParseRequest(documentUrl, config)),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new HttpError(502, "PROVIDER_ERROR", `Cohere Parse request failed with status ${response.status}: ${body}`, {
      status: response.status,
      body,
    });
  }
  const raw: unknown = await response.json();
  return { markdown: cohereMarkdown(raw), cost: estimateCost("cohere", raw), raw };
}

const AZURE_DEFAULT_MODEL_ID = "prebuilt-layout";
const AZURE_DEFAULT_API_VERSION = "2024-11-30";
const AZURE_DEFAULT_OUTPUT_CONTENT_FORMAT = "markdown";
const AZURE_POLL_ATTEMPTS = 300;

export function buildAzureAnalyzeUrl(endpoint: string, config: ProviderConfig): string {
  const modelId = stringConfigValue(config, "modelId") ?? AZURE_DEFAULT_MODEL_ID;
  const apiVersion = stringConfigValue(config, "apiVersion") ?? AZURE_DEFAULT_API_VERSION;
  const outputContentFormat =
    stringConfigValue(config, "outputContentFormat") ?? AZURE_DEFAULT_OUTPUT_CONTENT_FORMAT;
  const url = `${endpoint.replace(/\/+$/, "")}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze`;
  const params = new URLSearchParams({
    "api-version": apiVersion,
    outputContentFormat,
  });
  const features = azureFeatures(config.features);
  if (features !== null) params.set("features", features);
  return `${url}?${params.toString()}`;
}

async function parseAzureDocumentIntelligence(
  documentUrl: string,
  config: ProviderConfig,
  env: Env,
): Promise<ProviderResult> {
  const response = await fetch(buildAzureAnalyzeUrl(env.AZURE_DI_ENDPOINT, config), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": env.AZURE_DI_KEY,
    },
    body: JSON.stringify({ urlSource: documentUrl }),
  });
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_ERROR", `Azure Document Intelligence request failed with status ${response.status}.`);
  }
  const operationLocation = response.headers.get("operation-location");
  if (operationLocation === null || operationLocation.length === 0) {
    throw new HttpError(502, "PROVIDER_ERROR", "Azure Document Intelligence response did not include operation-location.");
  }
  const raw = await pollAzureDocumentIntelligence(operationLocation, env.AZURE_DI_KEY);
  const analyzeResult = isRecord(raw) && isRecord(raw.analyzeResult) ? raw.analyzeResult : {};
  const markdown = typeof analyzeResult.content === "string" ? analyzeResult.content : "";
  return { markdown, cost: estimateCost("azure_document_intelligence", raw, config), raw };
}

async function pollAzureDocumentIntelligence(operationLocation: string, key: string): Promise<unknown> {
  for (let attempt = 0; attempt < AZURE_POLL_ATTEMPTS; attempt += 1) {
    const response = await fetch(operationLocation, {
      headers: { "Ocp-Apim-Subscription-Key": key },
    });
    if (!response.ok) {
      throw new HttpError(502, "PROVIDER_ERROR", `Azure Document Intelligence poll failed with status ${response.status}.`);
    }
    const raw = await response.json();
    if (!isRecord(raw)) {
      throw new HttpError(502, "PROVIDER_ERROR", "Azure Document Intelligence poll response was not an object.");
    }
    const status = raw.status;
    if (status === "succeeded") return raw;
    if (status === "failed" || status === "canceled") {
      throw new HttpError(502, "PROVIDER_ERROR", `Azure Document Intelligence processing ${status}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new HttpError(504, "PROVIDER_TIMEOUT", "Azure Document Intelligence processing timed out.");
}

function stringConfigValue(config: ProviderConfig, key: string): string | null {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function azureFeatures(value: JsonValue | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (!Array.isArray(value)) return null;
  const features = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return features.length > 0 ? features.join(",") : null;
}

export function formValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "";
  return JSON.stringify(value);
}

async function pollDatalab(checkUrl: string, env: Env): Promise<unknown> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const raw = await datalabFetch("GET", checkUrl, env);
    if (!isRecord(raw)) throw new HttpError(502, "PROVIDER_ERROR", "Datalab poll response was not an object.");
    if (raw.status === "complete") return raw;
    if (raw.success === false && raw.status !== "processing") {
      throw new HttpError(502, "PROVIDER_ERROR", "Datalab processing failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new HttpError(504, "PROVIDER_TIMEOUT", "Datalab processing timed out.");
}

export async function datalabFetch(method: "GET" | "POST", endpoint: string, env: Env, body?: BodyInit): Promise<unknown> {
  const url = endpoint.startsWith("http") ? endpoint : `${env.DATALAB_BASE_URL ?? "https://www.datalab.to"}${endpoint}`;
  const response = await fetch(url, {
    method,
    headers: { "X-Api-Key": env.DATALAB_API_KEY },
    body,
  });
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_ERROR", `Datalab request failed with status ${response.status}.`);
  }
  return response.json();
}

export function providerHttpError(provider: Provider, error: unknown): HttpError {
  const details = providerErrorDetails(provider, error);
  const status = typeof details.status === "number" ? ` status ${details.status}` : "";
  const message = `${provider} provider request failed${status}: ${details.message}`;
  console.error("competitors provider error", details);
  return new HttpError(502, "PROVIDER_ERROR", message, details);
}

export function providerErrorDetails(provider: Provider, error: unknown): ErrorDetails {
  const record = isRecord(error) ? error : {};
  const status = firstNumber(record, ["status", "statusCode", "code"]);
  const responseRecord = isRecord(record.response) ? record.response : {};
  const responseStatus = firstNumber(responseRecord, ["status", "statusCode"]);
  const body = firstString(record, ["body", "text", "content"]) ?? firstString(responseRecord, ["body", "text", "content"]);
  const message = sanitizeProviderMessage(
    firstString(record, ["message", "error", "detail"]) ??
      firstString(responseRecord, ["message", "error", "detail"]) ??
      String(error),
  );
  return {
    provider,
    message,
    error_type: errorType(error),
    ...(status === null ? {} : { status }),
    ...(responseStatus === null ? {} : { response_status: responseStatus }),
    ...(body === null ? {} : { response_body_excerpt: sanitizeProviderMessage(body) }),
  };
}

function errorType(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) return error.name;
  if (isRecord(error) && typeof error.name === "string") return error.name;
  return typeof error;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/(AWS4-HMAC-SHA256\s+Credential=)[A-Z0-9]+/gi, "$1<redacted>")
    .replace(/(aws[_-]?access[_-]?key[_-]?id)(['":=\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1$2<redacted>")
    .replace(/(ocp-apim-subscription-key|subscription-key)(['":=\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1$2<redacted>")
    .replace(/(api[_-]?key|token|secret)(['":=\s]+)[A-Za-z0-9._~+/=-]+/gi, "$1$2<redacted>")
    .slice(0, 1000);
}
