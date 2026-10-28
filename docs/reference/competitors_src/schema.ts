export const PROVIDERS = [
  "reducto",
  "mistral_ocr",
  "google_mistral_ocr",
  "google_document_ai",
  "extend",
  "llamaparse",
  "datalab",
  "azure_document_intelligence",
  "pulse",
  "cohere",
] as const;

export type Provider = (typeof PROVIDERS)[number];

export const EXTRACT_PROVIDERS = ["extend", "llamaparse", "datalab"] as const;

export type ExtractProvider = (typeof EXTRACT_PROVIDERS)[number];

export interface ParseRequestBody {
  provider: Provider;
  document: {
    url: string;
  };
  config?: ProviderConfig;
}

export interface ExtractRequestBody extends ParseRequestBody {
  provider: ExtractProvider;
  schema: JsonSchema;
}

export type ProviderConfig = Record<string, JsonValue>;
export type JsonSchema = Record<string, JsonValue>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ErrorDetails = Record<string, JsonValue>;

export interface Cost {
  amount_usd: number | null;
  currency: "USD";
  source: "provider" | "estimated" | "unavailable";
  details: Record<string, unknown>;
}

export interface ProviderResult {
  markdown: string;
  cost: Cost;
  raw: unknown;
  duration_ms?: number;
}

export interface ExtractResult {
  result: JsonValue;
  cost: Cost;
  raw: unknown;
}

export interface ParseResponseBody {
  provider: Provider;
  markdown: string;
  raw: unknown;
  duration_ms: number;
  cost: Cost;
}

export interface ExtractResponseBody {
  provider: ExtractProvider;
  result: JsonValue;
  raw: unknown;
  duration_ms: number;
  cost: Cost;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ErrorDetails | null = null,
  ) {
    super(message);
  }
}

export function parseRequestBody(value: unknown): ParseRequestBody {
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }

  const provider = value.provider;
  if (!isProvider(provider)) {
    throw new HttpError(400, "INVALID_PROVIDER", `provider must be one of: ${PROVIDERS.join(", ")}.`);
  }

  const document = value.document;
  if (!isRecord(document)) {
    throw new HttpError(400, "INVALID_DOCUMENT", "document must be an object.");
  }

  const url = document.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new HttpError(400, "INVALID_DOCUMENT_URL", "document.url must be a non-empty string.");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new HttpError(400, "INVALID_DOCUMENT_URL", "document.url must use http or https.");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_DOCUMENT_URL", "document.url must be a valid URL.");
  }

  const config = value.config;
  if (config !== undefined && !isRecord(config)) {
    throw new HttpError(400, "INVALID_CONFIG", "config must be an object when provided.");
  }

  return {
    provider,
    document: { url },
    ...(config === undefined ? {} : { config: config as ProviderConfig }),
  };
}

export function parseExtractRequestBody(value: unknown): ExtractRequestBody {
  const body = parseRequestBody(value);
  if (!isExtractProvider(body.provider)) {
    throw new HttpError(400, "INVALID_PROVIDER", `extract provider must be one of: ${EXTRACT_PROVIDERS.join(", ")}.`);
  }

  const schema = isRecord(value) ? value.schema : undefined;
  if (!isRecord(schema)) {
    throw new HttpError(400, "INVALID_SCHEMA", "schema must be a JSON Schema object.");
  }

  return { ...body, provider: body.provider, schema: schema as JsonSchema };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDERS.includes(value as Provider);
}

function isExtractProvider(value: Provider): value is ExtractProvider {
  return EXTRACT_PROVIDERS.includes(value as ExtractProvider);
}
