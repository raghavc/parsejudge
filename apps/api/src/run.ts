import { NonRetryableError } from "cloudflare:workflows";
import {
  type Credentials,
  DEFAULT_MAX_CONCURRENCY,
  findPreset,
  type JudgeError,
  type PageInput,
  type ParseOutput,
  PROVIDERS,
  type ProviderError,
} from "@parsejudge/core";
import { Effect, Option } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { signedBlobUrl } from "./blobs.ts";
import { decryptCredentials } from "./credentials.ts";
import type { Env } from "./env.ts";
import { markdownKey, pagePngKey, rawKey } from "./keys.ts";

/** Runs an Effect inside a workflow step. Non-retryable errors stop the step's retries. */
export const runStep = <A>(program: Effect.Effect<A, ProviderError | JudgeError, HttpClient.HttpClient>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catch((error) => Effect.die(error.retryable ? new Error(error.message) : new NonRetryableError(error.message))),
    ),
  );

export const pageInput = async (env: Env, pageId: string): Promise<PageInput> => ({
  imageUrl: await signedBlobUrl(env.PUBLIC_URL, env.BLOB_SIGNING_KEY, pagePngKey(pageId)),
  image: Effect.promise(async () => {
    const object = await env.BLOBS.get(pagePngKey(pageId));
    if (object === null) throw new Error(`Missing page ${pageId}`);
    return new Uint8Array(await object.arrayBuffer());
  }),
});

/** BYOK credentials for the provider when the user gave them, else the hosted env secrets. */
export const credentialsFor = async (env: Env, runId: string, presetId: string): Promise<Credentials> => {
  const preset = findPreset(presetId);
  if (preset === undefined) throw new NonRetryableError(`Unknown preset ${presetId}`);
  const row = await env.DB.prepare("SELECT iv, ciphertext FROM run_credentials WHERE run_id = ? AND provider = ?")
    .bind(runId, preset.provider)
    .first<{ iv: string; ciphertext: string }>();
  if (row !== null) return decryptCredentials(env.CREDENTIALS_KEY, runId, row.iv, row.ciphertext);
  if (!preset.hosted) throw new NonRetryableError(`${preset.label} needs your own API key`);
  const hosted: Record<string, string> = {};
  for (const key of PROVIDERS[preset.provider].credentialKeys) {
    const value = env[key];
    if (typeof value === "string") hosted[key] = value;
  }
  return hosted;
};

export interface Cell {
  readonly runId: string;
  readonly pageId: string;
  readonly presetId: string;
}

/** Stores a finished parse. Idempotent, so a retried step can call it again. */
export const saveParse = async (env: Env, cell: Cell, output: ParseOutput, latencyMs: number) => {
  const { runId, pageId, presetId } = cell;
  const listPrice = findPreset(presetId)?.listPriceUsdPerPage ?? null;
  await env.BLOBS.put(markdownKey(runId, pageId, presetId), output.markdown);
  await env.BLOBS.put(rawKey(runId, pageId, presetId), JSON.stringify(output.raw));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO parses (run_id, page_id, preset_id, status, latency_ms, cost_usd, cost_source, error)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?, NULL)`,
  )
    .bind(runId, pageId, presetId, latencyMs, output.reportedCost?.usd ?? listPrice, output.reportedCost?.source ?? "list_price")
    .run();
};

export const saveFailure = (env: Env, cell: Cell, error: string) =>
  env.DB.prepare(`INSERT OR REPLACE INTO parses (run_id, page_id, preset_id, status, error) VALUES (?, ?, ?, 'failed', ?)`)
    .bind(cell.runId, cell.pageId, cell.presetId, error.slice(0, 1000))
    .run();

export const submitCell = async (env: Env, cell: Cell): Promise<{ readonly job: string | null; readonly startedAt: number }> => {
  const preset = findPreset(cell.presetId);
  if (preset === undefined) throw new NonRetryableError(`Unknown preset ${cell.presetId}`);
  const credentials = await credentialsFor(env, cell.runId, cell.presetId);
  const page = await pageInput(env, cell.pageId);
  const startedAt = Date.now();
  const submission = await runStep(PROVIDERS[preset.provider].submit(page, preset.config, credentials));
  if (submission._tag === "Pending") return { job: submission.job, startedAt };
  await saveParse(env, cell, submission.output, Date.now() - startedAt);
  return { job: null, startedAt };
};

/** Returns true when the vendor job finished and the result is stored. */
export const pollCell = async (env: Env, cell: Cell, job: string, startedAt: number): Promise<boolean> => {
  const preset = findPreset(cell.presetId);
  const poll = preset === undefined ? undefined : PROVIDERS[preset.provider].poll;
  if (preset === undefined || poll === undefined) throw new NonRetryableError(`${cell.presetId} cannot poll`);
  const credentials = await credentialsFor(env, cell.runId, cell.presetId);
  const output = await runStep(poll(job, credentials));
  if (Option.isNone(output)) return false;
  await saveParse(env, cell, output.value, Date.now() - startedAt);
  return true;
};

export interface Pool {
  readonly name: string;
  readonly limit: number;
}

const limitFor = (env: Env, pool: string, fallback: number): number => {
  const overrides = JSON.parse(env.MAX_CONCURRENCY ?? "{}") as Record<string, unknown>;
  const value = overrides[pool];
  return typeof value === "number" && value > 0 ? value : fallback;
};

const fingerprint = async (credentials: Credentials): Promise<string> => {
  const sorted = Object.keys(credentials)
    .sort()
    .map((key) => [key, credentials[key]]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sorted)));
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Concurrency pool for a preset: one per provider API key, so hosted and BYOK keys have separate limits. */
export const providerPool = async (env: Env, cell: Cell): Promise<Pool> => {
  const preset = findPreset(cell.presetId);
  if (preset === undefined) throw new NonRetryableError(`Unknown preset ${cell.presetId}`);
  const adapter = PROVIDERS[preset.provider];
  const credentials = await credentialsFor(env, cell.runId, cell.presetId);
  return {
    name: `${preset.provider}:${await fingerprint(credentials)}`,
    limit: limitFor(env, preset.provider, adapter.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
  };
};

export const judgePool = (env: Env): Pool => ({ name: "judge", limit: limitFor(env, "judge", DEFAULT_MAX_CONCURRENCY) });
