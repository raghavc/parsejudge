import type { Converter } from "./converter.ts";
import type { DocumentWorkflowParams, PageWorkflowParams, RunWorkflowParams } from "./workflows.ts";

export interface Env {
  readonly DB: D1Database;
  readonly BLOBS: R2Bucket;
  readonly RUN_EVENTS: DurableObjectNamespace;
  readonly PROVIDER_SLOTS: DurableObjectNamespace;
  readonly CONVERTER: DurableObjectNamespace<Converter>;
  readonly RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  readonly PAGE_WORKFLOW: Workflow<PageWorkflowParams>;
  readonly DOCUMENT_WORKFLOW: Workflow<DocumentWorkflowParams>;
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
  /** Analytics Engine dataset for per-call cost and latency (see usage.ts). Unbound turns it off. */
  readonly USAGE?: AnalyticsEngineDataset;
  /** "email" (sign-in by emailed code or link) or "dev" (also trusts the x-parsejudge-user header; local only). */
  readonly AUTH_MODE: string;
  /** HMAC key for sign-in codes, links and session ids. */
  readonly AUTH_KEY: string;
  readonly EMAIL: SendEmail;
  readonly EMAIL_FROM: string;
  /** Cloudflare Turnstile on sign-in. Unset turns the check off. */
  readonly TURNSTILE_SITEKEY?: string;
  readonly TURNSTILE_SECRET?: string;
  /** Per-login limits on title generation and on uploads before sign-in. Unset turns them off. */
  readonly TITLE_LIMIT?: RateLimit;
  readonly UPLOAD_LIMIT?: RateLimit;
  /** Hosted provider credentials (REDUCTO_API_KEY, AZURE_DI_KEY, ...). */
  readonly [credential: string]: unknown;
}
