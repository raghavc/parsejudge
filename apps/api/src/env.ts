import { Data, Schema } from "effect";
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

const positiveInt = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/));

/** The vars and secrets every Worker entry point relies on. Provider keys are checked per preset when a run starts. */
export const EnvVars = Schema.Struct({
  PUBLIC_URL: Schema.String.check(Schema.isPattern(/^https?:\/\/[^/\s]+/)),
  AUTH_MODE: Schema.Literals(["email", "dev"]),
  AUTH_KEY: Schema.String.check(Schema.isMinLength(32)),
  /** 32 bytes, base64. */
  CREDENTIALS_KEY: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9+/]{43}=$/)),
  BLOB_SIGNING_KEY: Schema.NonEmptyString,
  EMAIL_FROM: Schema.String.check(Schema.isPattern(/^[^@\s]+@[^@\s]+$/)),
  JUDGE_REASONING_EFFORT: Schema.Literals(["low", "medium", "high"]),
  MAX_PAGES_PER_RUN: positiveInt,
  MAX_CONCURRENCY: Schema.optional(
    Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThan(0)))),
  ),
  TURNSTILE_SITEKEY: Schema.optional(Schema.String),
  TURNSTILE_SECRET: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((vars) =>
    vars.TURNSTILE_SITEKEY && !vars.TURNSTILE_SECRET ? "TURNSTILE_SITEKEY is set without TURNSTILE_SECRET" : undefined,
  ),
);

export class InvalidEnv extends Data.TaggedError("InvalidEnv")<{ readonly message: string }> {}

const decoded = new WeakMap<object, InvalidEnv | null>();

/** Why the deployment's env is unusable, or null. Decoded once per env object. */
export const envError = (env: Env): InvalidEnv | null => {
  let error = decoded.get(env);
  if (error === undefined) {
    const result = Schema.decodeUnknownExit(EnvVars)(env, { errors: "all" });
    error = result._tag === "Success" ? null : new InvalidEnv({ message: String(result.cause) });
    decoded.set(env, error);
    if (error !== null) console.error(JSON.stringify({ event: "invalid_env", error: error.message }));
  }
  return error;
};
