export const PROVIDER_NAMES: Record<string, string> = {
  reducto: "Reducto",
  azure_document_intelligence: "Azure Document Intelligence",
  aws_textract: "AWS Textract",
  google_document_ai: "Google Document AI",
  mistral_ocr: "Mistral OCR",
  extend: "Extend",
  llamaparse: "LlamaParse",
  datalab: "Datalab",
  pulse: "Pulse",
  cohere: "Cohere",
};

export const SHORT_NAMES: Record<string, string> = {
  ...PROVIDER_NAMES,
  azure_document_intelligence: "Azure",
  aws_textract: "Textract",
  google_document_ai: "Google",
  mistral_ocr: "Mistral",
};

/** BYOK providers take a single API key. */
export const BYOK_KEY: Record<string, string> = {
  mistral_ocr: "MISTRAL_API_KEY",
  extend: "EXTEND_API_KEY",
  llamaparse: "LLAMA_CLOUD_API_KEY",
  datalab: "DATALAB_API_KEY",
  pulse: "PULSE_API_KEY",
  cohere: "COHERE_API_KEY",
};

export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;
export const shortName = (id: string) => SHORT_NAMES[id] ?? id;
export const perThousand = (usdPerPage: number) => `$${Math.round(usdPerPage * 1000)}`;
export const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);

/** Display order on the landing page. */
export const PROVIDER_ORDER = [
  "aws_textract",
  "azure_document_intelligence",
  "google_document_ai",
  "reducto",
  "llamaparse",
  "mistral_ocr",
  "extend",
  "datalab",
  "pulse",
  "cohere",
];

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
export const numberWord = (n: number) => NUMBER_WORDS[n] ?? String(n);
