import type { PageWorkflowParams, RunWorkflowParams } from "./workflows.ts";

export interface Env {
  readonly DB: D1Database;
  readonly BLOBS: R2Bucket;
  readonly RUN_EVENTS: DurableObjectNamespace;
  readonly RUN_WORKFLOW: Workflow<RunWorkflowParams>;
  readonly PAGE_WORKFLOW: Workflow<PageWorkflowParams>;
  readonly PUBLIC_URL: string;
  readonly JUDGE_MODEL: string;
  readonly JUDGE_REASONING_EFFORT: "low" | "medium" | "high";
  readonly JUDGE_BASE_URL: string;
  readonly MAX_PAGES_PER_RUN: string;
  readonly BLOB_SIGNING_KEY: string;
  readonly CREDENTIALS_KEY: string;
  readonly OPENAI_API_KEY: string;
  readonly AUTH_MODE: string;
  /** Hosted provider credentials (REDUCTO_API_KEY, AZURE_DI_KEY, ...). */
  readonly [credential: string]: unknown;
}
