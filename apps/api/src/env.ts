import type { Converter } from "./converter.ts";
import type { PageWorkflowParams, RunWorkflowParams } from "./workflows.ts";

export interface Env {
  readonly DB: D1Database;
  readonly BLOBS: R2Bucket;
  readonly RUN_EVENTS: DurableObjectNamespace;
  readonly PROVIDER_SLOTS: DurableObjectNamespace;
  readonly CONVERTER: DurableObjectNamespace<Converter>;
  readonly RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  readonly PAGE_WORKFLOW: Workflow<PageWorkflowParams>;
  readonly PUBLIC_URL: string;
  readonly JUDGE_MODEL: string;
  readonly SMALL_MODEL: string;
  readonly JUDGE_REASONING_EFFORT: "low" | "medium" | "high";
  readonly JUDGE_BASE_URL: string;
  readonly MAX_PAGES_PER_RUN: string;
  /** JSON map from provider id or "judge" to max requests in flight per API key, e.g. `{"reducto": 200}`. */
  readonly MAX_CONCURRENCY?: string;
  readonly BLOB_SIGNING_KEY: string;
  readonly CREDENTIALS_KEY: string;
  readonly JUDGE_API_KEY: string;
  /** incident.io HTTP alert source URL, with its token. Unset turns budget alerts off. */
  readonly BUDGET_ALERT_URL?: string;
  readonly AUTH_MODE: string;
  /** Hosted provider credentials (REDUCTO_API_KEY, AZURE_DI_KEY, ...). */
  readonly [credential: string]: unknown;
}
