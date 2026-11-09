import type { ProviderId } from "../domain.ts";
import type { ProviderAdapter } from "../provider.ts";
import { azure } from "./azure.ts";
import { cohere } from "./cohere.ts";
import { datalab } from "./datalab.ts";
import { extend } from "./extend.ts";
import { google } from "./google.ts";
import { llamaparse } from "./llamaparse.ts";
import { mistral } from "./mistral.ts";
import { pulse } from "./pulse.ts";
import { reducto } from "./reducto.ts";
import { textract } from "./textract.ts";

export const PROVIDERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  reducto,
  azure_document_intelligence: azure,
  aws_textract: textract,
  google_document_ai: google,
  mistral_ocr: mistral,
  extend,
  llamaparse,
  datalab,
  pulse,
  cohere,
};
