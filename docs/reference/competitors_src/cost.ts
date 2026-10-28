import type { Cost, ExtractProvider, Provider, ProviderConfig } from "./schema";
import { isRecord } from "./schema";
import { cohereBilledPages } from "./cohere";
import { DEFAULT_GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION } from "./google_document_ai";

const REDUCTO_CREDIT_USD = 0.015;
const MISTRAL_OCR_DEFAULT_MODEL = "mistral-ocr-latest";
const MISTRAL_OCR_LEGACY_PER_PAGE_USD = 2 / 1000;
const MISTRAL_OCR_4_DIRECT_API_PER_PAGE_USD = 4 / 1000;
const GOOGLE_MISTRAL_OCR_2505_INPUT_PER_PAGE_USD = 0.0005;
const GOOGLE_MISTRAL_OCR_2505_OUTPUT_PER_PAGE_USD = 0.0005;
const GOOGLE_MISTRAL_OCR_2505_PER_PAGE_USD =
  GOOGLE_MISTRAL_OCR_2505_INPUT_PER_PAGE_USD + GOOGLE_MISTRAL_OCR_2505_OUTPUT_PER_PAGE_USD;
const GOOGLE_DOCUMENT_AI_LAYOUT_PER_PAGE_USD = 10 / 1000;
const GOOGLE_DOCUMENT_AI_OCR_PER_PAGE_USD = 1.5 / 1000;
const EXTEND_CREDIT_USD = 0.01;
const LLAMAPARSE_CREDITS_PER_PAGE: Record<string, number> = {
  fast: 1,
  cost_effective: 3,
  agentic: 10,
  agentic_plus: 45,
};
const LLAMAPARSE_CREDIT_USD = 0.00125;
const DATALAB_PER_PAGE_USD: Record<string, number> = {
  fast: 4 / 1000,
  balanced: 4 / 1000,
  accurate: 10 / 1000,
};
const PULSE_CREDIT_USD = 0.015;
const COHERE_PARSE_PER_PAGE_USD = 1.5 / 1000;
const AZURE_DOCUMENT_INTELLIGENCE_PER_PAGE_USD = 10 / 1000;
// Extraction credits only; a LlamaExtract page also bills the parse tier of the same name.
const LLAMAEXTRACT_CREDITS_PER_PAGE: Record<string, number> = {
  cost_effective: 5,
  agentic: 15,
  agentic_plus: 50,
};
const DATALAB_EXTRACT_PER_PAGE_USD: Record<string, number> = {
  fast: 6 / 1000,
  balanced: 15 / 1000,
  accurate: 20 / 1000,
};

export function unavailableCost(details: Record<string, unknown> = {}): Cost {
  return { amount_usd: null, currency: "USD", source: "unavailable", details };
}

export function estimateCost(provider: Provider, raw: unknown, config?: ProviderConfig): Cost {
  switch (provider) {
    case "reducto":
      return reductoCost(raw);
    case "mistral_ocr":
      return mistralCost(raw, config);
    case "google_mistral_ocr":
      return googleMistralCost(raw);
    case "google_document_ai":
      return googleDocumentAiCost(raw, config);
    case "extend":
      return extendCost(raw);
    case "llamaparse":
      return llamaCost(raw);
    case "datalab":
      return datalabCost(raw, config);
    case "pulse":
      return pulseCost(raw);
    case "cohere":
      return cohereCost(raw);
    case "azure_document_intelligence":
      return azureDocumentIntelligenceCost(raw, config);
  }
}

function googleDocumentAiCost(raw: unknown, config?: ProviderConfig): Cost {
  const document = isRecord(raw) && isRecord(raw.document) ? raw.document : {};
  const pages = googleDocumentAiPageCount(document);
  if (pages === null) return unavailableCost({ reason: "missing page count" });
  const processorType = config?.processorType === "ocr" ? "ocr" : "layout";
  const rate = processorType === "ocr" ? GOOGLE_DOCUMENT_AI_OCR_PER_PAGE_USD : GOOGLE_DOCUMENT_AI_LAYOUT_PER_PAGE_USD;
  return {
    amount_usd: pages * rate,
    currency: "USD",
    source: "estimated",
    details: {
      pages,
      rate_usd_per_page: rate,
      processor_type: processorType,
      processor_version:
        processorType === "layout"
          ? (config?.processorVersion ?? DEFAULT_GOOGLE_DOCUMENT_AI_PROCESSOR_VERSION)
          : null,
    },
  };
}

function googleDocumentAiPageCount(document: Record<string, unknown>): number | null {
  if (Array.isArray(document.pages) && document.pages.length > 0) return document.pages.length;
  const documentLayout = isRecord(document.documentLayout) ? document.documentLayout : {};
  const blocks = Array.isArray(documentLayout.blocks) ? documentLayout.blocks : [];
  const blockPageCount = maxPageEnd(blocks);
  if (blockPageCount !== null) return blockPageCount;
  const chunkedDocument = isRecord(document.chunkedDocument) ? document.chunkedDocument : {};
  const chunks = Array.isArray(chunkedDocument.chunks) ? chunkedDocument.chunks : [];
  return maxPageEnd(chunks);
}

function maxPageEnd(values: unknown[]): number | null {
  const pageEnds = values.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.pageSpan)) return [];
    const pageEnd = value.pageSpan.pageEnd;
    return typeof pageEnd === "number" && Number.isInteger(pageEnd) && pageEnd > 0 ? [pageEnd] : [];
  });
  return pageEnds.length > 0 ? Math.max(...pageEnds) : null;
}

export function estimateExtractCost(provider: ExtractProvider, raw: unknown, config: ProviderConfig): Cost {
  switch (provider) {
    case "extend":
      return extendCost(raw);
    case "llamaparse":
      return llamaExtractCost(raw, config);
    case "datalab":
      return datalabExtractCost(raw, config);
  }
}

function llamaExtractCost(raw: unknown, config: ProviderConfig): Cost {
  const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : {};
  const credits = numberValue(usage.credits);
  if (credits !== null) {
    return {
      amount_usd: credits * LLAMAPARSE_CREDIT_USD,
      currency: "USD",
      source: "provider",
      details: { credits, rate_usd_per_credit: LLAMAPARSE_CREDIT_USD, usage },
    };
  }
  const pages = numberValue(usage.num_pages_extracted);
  const tier = typeof config.tier === "string" ? config.tier : "agentic";
  const parseTier = typeof config.parse_tier === "string" ? config.parse_tier : tier;
  const extractCredits = LLAMAEXTRACT_CREDITS_PER_PAGE[tier] ?? LLAMAEXTRACT_CREDITS_PER_PAGE.agentic;
  const parseCredits = LLAMAPARSE_CREDITS_PER_PAGE[parseTier] ?? LLAMAPARSE_CREDITS_PER_PAGE.agentic;
  const creditsPerPage = extractCredits + parseCredits;
  if (pages === null) return unavailableCost({ reason: "missing usage.credits and usage.num_pages_extracted", tier });
  return {
    amount_usd: pages * creditsPerPage * LLAMAPARSE_CREDIT_USD,
    currency: "USD",
    source: "estimated",
    details: {
      pages,
      tier,
      parse_tier: parseTier,
      credits_per_page: creditsPerPage,
      extract_credits_per_page: extractCredits,
      parse_credits_per_page: parseCredits,
      rate_usd_per_credit: LLAMAPARSE_CREDIT_USD,
    },
  };
}

function datalabExtractCost(raw: unknown, config: ProviderConfig): Cost {
  const costBreakdown = isRecord(raw) && isRecord(raw.cost_breakdown) ? raw.cost_breakdown : null;
  const cents = costBreakdown ? numberValue(costBreakdown.final_cost_cents) : null;
  if (cents !== null) return { amount_usd: cents / 100, currency: "USD", source: "provider", details: { cost_breakdown: costBreakdown } };

  const mode = typeof config.extraction_mode === "string" ? config.extraction_mode : "balanced";
  const ratePerPage = DATALAB_EXTRACT_PER_PAGE_USD[mode] ?? DATALAB_EXTRACT_PER_PAGE_USD.balanced;
  const pageCount = isRecord(raw) ? numberValue(raw.page_count) : null;
  if (pageCount === null) return unavailableCost({ reason: "missing page_count", extraction_mode: mode });
  return {
    amount_usd: pageCount * ratePerPage,
    currency: "USD",
    source: "estimated",
    details: { pages: pageCount, rate_usd_per_page: ratePerPage, extraction_mode: mode },
  };
}

function googleMistralCost(raw: unknown): Cost {
  const pages = isRecord(raw) && Array.isArray(raw.pages) ? raw.pages.length : null;
  if (pages === null) return unavailableCost({ reason: "missing pages", model: "mistral-ocr-2505" });
  return {
    amount_usd: pages * GOOGLE_MISTRAL_OCR_2505_PER_PAGE_USD,
    currency: "USD",
    source: "estimated",
    details: {
      pages,
      rate_usd_per_page: GOOGLE_MISTRAL_OCR_2505_PER_PAGE_USD,
      input_rate_usd_per_page: GOOGLE_MISTRAL_OCR_2505_INPUT_PER_PAGE_USD,
      output_rate_usd_per_page: GOOGLE_MISTRAL_OCR_2505_OUTPUT_PER_PAGE_USD,
      model: "mistral-ocr-2505",
      hosting: "google_model_garden",
    },
  };
}
function reductoCost(raw: unknown): Cost {
  const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : {};
  const credits = numberValue(usage.credits);
  if (credits !== null) {
    return {
      amount_usd: credits * REDUCTO_CREDIT_USD,
      currency: "USD",
      source: "provider",
      details: { credits, rate_usd_per_credit: REDUCTO_CREDIT_USD, num_pages: numberValue(usage.num_pages) },
    };
  }
  return unavailableCost({ reason: "missing usage.credits" });
}

function mistralCost(raw: unknown, config?: ProviderConfig): Cost {
  const pages = isRecord(raw) && Array.isArray(raw.pages) ? raw.pages.length : null;
  if (pages === null) return unavailableCost({ reason: "missing pages" });
  const model = mistralModel(raw, config);
  const ratePerPage = isMistralOcr4DirectApiModel(model)
    ? MISTRAL_OCR_4_DIRECT_API_PER_PAGE_USD
    : MISTRAL_OCR_LEGACY_PER_PAGE_USD;
  return {
    amount_usd: pages * ratePerPage,
    currency: "USD",
    source: "estimated",
    details: { pages, rate_usd_per_page: ratePerPage, model },
  };
}

function mistralModel(raw: unknown, config?: ProviderConfig): string | null {
  if (typeof config?.model === "string") return config.model;
  if (isRecord(raw) && typeof raw.model === "string") return raw.model;
  return MISTRAL_OCR_DEFAULT_MODEL;
}

function isMistralOcr4DirectApiModel(model: string | null): boolean {
  return model === MISTRAL_OCR_DEFAULT_MODEL || model?.startsWith("mistral-ocr-4") === true;
}

function extendCost(raw: unknown): Cost {
  const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : {};
  const credits = numberValue(usage.totalCredits) ?? numberValue(usage.credits);
  if (credits !== null) {
    return {
      amount_usd: credits * EXTEND_CREDIT_USD,
      currency: "USD",
      source: "provider",
      details: { credits, rate_usd_per_credit: EXTEND_CREDIT_USD },
    };
  }
  return unavailableCost({ reason: "missing usage.credits" });
}

function llamaCost(raw: unknown): Cost {
  const metadata = isRecord(raw) && isRecord(raw.metadata) ? raw.metadata : {};
  const pages = isRecord(metadata) && Array.isArray(metadata.pages) ? metadata.pages.length : null;
  const job = isRecord(raw) && isRecord(raw.job) ? raw.job : {};
  const tier = typeof job.tier === "string" ? job.tier : "agentic";
  const creditsPerPage = LLAMAPARSE_CREDITS_PER_PAGE[tier] ?? LLAMAPARSE_CREDITS_PER_PAGE.agentic;

  if (pages === null) return unavailableCost({ reason: "missing metadata.pages", tier });
  return {
    amount_usd: pages * creditsPerPage * LLAMAPARSE_CREDIT_USD,
    currency: "USD",
    source: "estimated",
    details: { pages, tier, credits_per_page: creditsPerPage, rate_usd_per_credit: LLAMAPARSE_CREDIT_USD },
  };
}

function datalabCost(raw: unknown, config?: ProviderConfig): Cost {
  const costBreakdown = isRecord(raw) && isRecord(raw.cost_breakdown) ? raw.cost_breakdown : null;
  const cents = costBreakdown ? numberValue(costBreakdown.final_cost_cents) : null;
  if (cents !== null) return { amount_usd: cents / 100, currency: "USD", source: "provider", details: { cost_breakdown: costBreakdown } };

  const mode = typeof config?.mode === "string" ? config.mode : "balanced";
  const ratePerPage = DATALAB_PER_PAGE_USD[mode] ?? DATALAB_PER_PAGE_USD.balanced;
  const pageCount = isRecord(raw) ? numberValue(raw.page_count) : null;
  if (pageCount === null) return unavailableCost({ reason: "missing page_count", mode });
  return {
    amount_usd: pageCount * ratePerPage,
    currency: "USD",
    source: "estimated",
    details: { pages: pageCount, rate_usd_per_page: ratePerPage, mode },
  };
}

function cohereCost(raw: unknown): Cost {
  const pages = cohereBilledPages(raw);
  if (pages === null) return unavailableCost({ reason: "missing billed pages" });
  return {
    amount_usd: pages * COHERE_PARSE_PER_PAGE_USD,
    currency: "USD",
    source: "estimated",
    details: { pages, rate_usd_per_page: COHERE_PARSE_PER_PAGE_USD },
  };
}

function pulseCost(raw: unknown): Cost {
  const record = isRecord(raw) ? raw : {};
  const credits = numberValue(record.credits_used);
  if (credits !== null) {
    return {
      amount_usd: credits * PULSE_CREDIT_USD,
      currency: "USD",
      source: "estimated",
      details: { credits, rate_usd_per_credit: PULSE_CREDIT_USD },
    };
  }
  const pageCount = numberValue(record.page_count);
  if (pageCount === null) return unavailableCost({ reason: "missing page_count" });
  return {
    amount_usd: pageCount * PULSE_CREDIT_USD,
    currency: "USD",
    source: "estimated",
    details: { pages: pageCount, credits_per_page: 1, rate_usd_per_credit: PULSE_CREDIT_USD },
  };
}

function azureDocumentIntelligenceCost(raw: unknown, config?: ProviderConfig): Cost {
  const analyzeResult = isRecord(raw) && isRecord(raw.analyzeResult) ? raw.analyzeResult : {};
  const pages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages.length : null;
  if (pages === null) {
    return unavailableCost({ reason: "missing analyzeResult.pages" });
  }
  const features = config?.features;
  return {
    amount_usd: pages * AZURE_DOCUMENT_INTELLIGENCE_PER_PAGE_USD,
    currency: "USD",
    source: "estimated",
    details: {
      pages,
      rate_usd_per_page: AZURE_DOCUMENT_INTELLIGENCE_PER_PAGE_USD,
      ...(features === undefined ? {} : { features }),
      note: "Azure add-on feature charges are not modeled.",
    },
  };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
