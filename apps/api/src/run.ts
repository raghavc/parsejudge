import { NonRetryableError } from "cloudflare:workflows";
import {
  type Credentials,
  DEFAULT_MAX_CONCURRENCY,
  findPreset,
  type JudgeError,
  type PageInput,
  type PageResult,
  type ParseOutput,
  PROVIDERS,
  type ProviderError,
  summarize,
} from "@parsejudge/core";
import { Data, Effect, Layer, Option } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { signedBlobUrl } from "./blobs.ts";
import { decryptCredentials } from "./credentials.ts";
import type { Env } from "./env.ts";
import type { RunEvents } from "./events.ts";
import { markdownKey, pageId as pageIdOf, pagePngKey, rawKey } from "./keys.ts";
import { recordUsage } from "./usage.ts";

/** Runs an Effect inside a workflow step. Non-retryable errors stop the step's retries. */
export const runStep = <A>(
  program: Effect.Effect<A, ProviderError | JudgeError, HttpClient.HttpClient>,
  fetch?: typeof globalThis.fetch,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(fetch === undefined ? Layer.empty : Layer.succeed(FetchHttpClient.Fetch, fetch)),
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

/**
 * Stores a finished parse. Idempotent, so a retried step can call it again.
 * `latencyMs` runs from submit to result in hand; `queueMs` is the wait for a concurrency slot before submit.
 */
export const saveParse = async (env: Env, cell: Cell, output: ParseOutput, latencyMs: number, queueMs: number) => {
  const { runId, pageId, presetId } = cell;
  const listPrice = findPreset(presetId)?.listPriceUsdPerPage ?? null;
  const costUsd = output.reportedCost?.usd ?? listPrice;
  await env.BLOBS.put(markdownKey(runId, pageId, presetId), output.markdown);
  await env.BLOBS.put(rawKey(runId, pageId, presetId), JSON.stringify(output.raw));
  await env.DB.prepare(
    `INSERT OR REPLACE INTO parses (run_id, page_id, preset_id, status, latency_ms, queue_ms, cost_usd, cost_source, error)
     VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, NULL)`,
  )
    .bind(runId, pageId, presetId, latencyMs, queueMs, costUsd, output.reportedCost?.source ?? "list_price")
    .run();
  recordUsage(env, { kind: "provider", name: presetId, runId, pageId, status: "ok", costUsd: costUsd ?? 0, latencyMs, queueMs });
};

export const saveFailure = (env: Env, cell: Cell, error: string) => {
  recordUsage(env, {
    kind: "provider",
    name: cell.presetId,
    runId: cell.runId,
    pageId: cell.pageId,
    status: "failed",
    costUsd: 0,
    latencyMs: 0,
  });
  return env.DB.prepare(`INSERT OR REPLACE INTO parses (run_id, page_id, preset_id, status, error) VALUES (?, ?, ?, 'failed', ?)`)
    .bind(cell.runId, cell.pageId, cell.presetId, error.slice(0, 1000))
    .run();
};

export const submitCell = async (
  env: Env,
  cell: Cell,
  queueMs: number,
): Promise<{ readonly job: string | null; readonly startedAt: number }> => {
  const preset = findPreset(cell.presetId);
  if (preset === undefined) throw new NonRetryableError(`Unknown preset ${cell.presetId}`);
  const credentials = await credentialsFor(env, cell.runId, cell.presetId);
  const page = await pageInput(env, cell.pageId);
  const startedAt = Date.now();
  const submission = await runStep(PROVIDERS[preset.provider].submit(page, preset.config, credentials));
  if (submission._tag === "Pending") return { job: submission.job, startedAt };
  await saveParse(env, cell, submission.output, Date.now() - startedAt, queueMs);
  return { job: null, startedAt };
};

/** Returns true when the vendor job finished and the result is stored. */
export const pollCell = async (env: Env, cell: Cell, job: string, startedAt: number, queueMs: number): Promise<boolean> => {
  const preset = findPreset(cell.presetId);
  const poll = preset === undefined ? undefined : PROVIDERS[preset.provider].poll;
  if (preset === undefined || poll === undefined) throw new NonRetryableError(`${cell.presetId} cannot poll`);
  const credentials = await credentialsFor(env, cell.runId, cell.presetId);
  const output = await runStep(poll(job, credentials));
  if (Option.isNone(output)) return false;
  await saveParse(env, cell, output.value, Date.now() - startedAt, queueMs);
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

/** Error of a parse the owner skipped with Continue. Skipped parses are not results, so the summary leaves them out. */
export const SKIPPED = "Skipped by user";

/** Run workflow statuses that can still receive `pages-done` and summarize. */
const ALIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

/** Continue was pressed before the run started its pages, so there is nothing to skip yet. */
export class RunNotStarted extends Data.TaggedError("RunNotStarted")<{ readonly runId: string }> {}

/** A read or write that Continue needs failed. */
export class ContinueFailed extends Data.TaggedError("ContinueFailed")<{ readonly step: string; readonly message: string }> {}

export const runEvents = (env: Env, runId: string) =>
  env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(runId)) as unknown as DurableObjectStub<RunEvents>;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sets the run's final status and deletes its credentials. Returns whether the status changed:
 * a failure never overwrites a run that already succeeded (for example one finished by Continue).
 */
export const finishRun = async (env: Env, runId: string, status: "succeeded" | "failed", error: string | null) => {
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ?${status === "failed" ? " AND status != 'succeeded'" : ""}`,
    ).bind(status, error, Date.now(), runId),
    env.DB.prepare("DELETE FROM run_credentials WHERE run_id = ?").bind(runId),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
};

/** Computes the summary over the run's parses, stores it, and marks the run succeeded. */
export const summarizeRun = async (env: Env, runId: string): Promise<void> => {
  const parses = await env.DB.prepare(
    `SELECT p.page_id, p.preset_id, p.status, p.latency_ms, p.queue_ms, p.cost_usd, p.cost_source, v.score, v.reasoning, v.errors
     FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id)
     WHERE p.run_id = ? AND (p.error IS NULL OR p.error != ?)`,
  )
    .bind(runId, SKIPPED)
    .all<Record<string, string | number | null>>();
  const results: Array<PageResult> = parses.results.map((row) => ({
    pageId: String(row.page_id),
    presetId: String(row.preset_id),
    status: row.status === "succeeded" ? "succeeded" : "failed",
    ...(typeof row.latency_ms === "number" ? { latencyMs: row.latency_ms } : {}),
    ...(typeof row.queue_ms === "number" ? { queueMs: row.queue_ms } : {}),
    ...(typeof row.cost_usd === "number"
      ? { cost: { usd: row.cost_usd, source: row.cost_source === "provider" ? "provider" : "list_price" } }
      : {}),
    ...(typeof row.score === "number"
      ? {
          verdict: {
            presetId: String(row.preset_id),
            score: row.score,
            reasoning: String(row.reasoning),
            errors: JSON.parse(String(row.errors)),
          },
        }
      : {}),
  }));
  await env.DB.prepare("UPDATE runs SET summary = ? WHERE id = ?")
    .bind(JSON.stringify(summarize(results)), runId)
    .run();
  await finishRun(env, runId, "succeeded", null);
};

const attempt = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => new ContinueFailed({ step, message: messageOf(error) }) });

const logged = <A>(effect: Effect.Effect<A, ContinueFailed>, label: string, id: string) =>
  effect.pipe(
    Effect.catchTag("ContinueFailed", (error) => Effect.sync(() => console.error(label, id, error.step, error.message))),
  );

const runPageIds = async (env: Env, runId: string) => {
  const documents = await env.DB.prepare(
    "SELECT d.id, d.page_count FROM run_documents r JOIN documents d ON d.id = r.document_id WHERE r.run_id = ?",
  )
    .bind(runId)
    .all<{ id: string; page_count: number }>();
  return documents.results.flatMap((d) => Array.from({ length: d.page_count }, (_, index) => pageIdOf(d.id, index)));
};

/** Stops a skipped page's workflow, so it does not keep a slot or write results after the summary. */
const stopPage = (env: Env, instanceId: string) =>
  logged(
    attempt("stop page", async () => {
      const instance = await env.PAGE_WORKFLOW.get(instanceId);
      if (ALIVE.has((await instance.status()).status)) await instance.terminate();
    }),
    "Could not stop skipped page",
    instanceId,
  );

/** Stops the page workflows of a run that has failed, so they stop calling providers. */
export const stopPendingPages = Effect.fn("stopPendingPages")(function* (env: Env, runId: string) {
  const pageIds = yield* attempt("list pages", () => runPageIds(env, runId));
  const state = yield* attempt("find pending pages", () => runEvents(env, runId).pending(pageIds));
  if (state === null) return;
  yield* Effect.forEach(state.pending, (page) => stopPage(env, `${state.workflow}-${page}`), { concurrency: 10, discard: true });
});

/**
 * Marks a `running` run failed when its run workflow can no longer finish it (errored or terminated after even
 * `record failure` failed). Called when the run is read, so the owner sees `failed` and can press Continue.
 */
export const reconcileRun = Effect.fn("reconcileRun")(function* (env: Env, runId: string) {
  const state = yield* attempt("find run workflow", () => runEvents(env, runId).pending([]));
  if (state === null) return false;
  const status = yield* attempt("run workflow status", async () => (await env.RUN_WORKFLOW.get(state.workflow)).status());
  if (status.status !== "errored" && status.status !== "terminated") return false;
  return yield* attempt("record failure", () =>
    finishRun(env, runId, "failed", `Run workflow ${status.status}: ${status.error?.message ?? "no error message"}`),
  );
});

/** Sends `pages-done` to the run workflow. False when it can no longer summarize (errored, terminated, complete or gone). */
const wakeWorkflow = (env: Env, instanceId: string) =>
  attempt("wake run workflow", async () => {
    const instance = await env.RUN_WORKFLOW.get(instanceId);
    if (!ALIVE.has((await instance.status()).status)) return false;
    await instance.sendEvent({ type: "pages-done", payload: { skipped: true } });
    return true;
  }).pipe(
    Effect.catchTag("ContinueFailed", (error) =>
      Effect.sync(() => {
        console.warn("Run workflow unavailable; summarizing directly", instanceId, error.message);
        return false;
      }),
    ),
  );

/**
 * Continue: skips every page that has not reported done and summarizes the pages that finished. Each skipped page
 * gets a failed parse with error `SKIPPED` for every preset without a parse. A waiting run workflow summarizes on
 * `pages-done`; when the workflow cannot, the summary is written here. Idempotent.
 */
export const continueRun = Effect.fn("continueRun")(function* (env: Env, runId: string) {
  const run = yield* attempt("load run", () =>
    env.DB.prepare("SELECT status, preset_ids FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ status: string; preset_ids: string }>(),
  );
  if (run === null || run.status === "succeeded") return { skipped: 0 };
  const events = runEvents(env, runId);
  const pageIds = yield* attempt("list pages", () => runPageIds(env, runId));
  const state = yield* attempt("find pending pages", () => events.pending(pageIds));
  if (state === null) return yield* new RunNotStarted({ runId });
  if (state.pending.length > 0) {
    yield* attempt("record skipped parses", () =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO parses (run_id, page_id, preset_id, status, error)
         SELECT ?, page.value, preset.value, 'failed', ? FROM json_each(?) page, json_each(?) preset`,
      )
        .bind(runId, SKIPPED, JSON.stringify(state.pending), run.preset_ids)
        .run(),
    );
    // A skipped page whose parses finished but were never judged gets a judge failure, so the report shows it.
    yield* attempt("record skipped judging", () =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO judge_failures (run_id, page_id, error)
         SELECT DISTINCT p.run_id, p.page_id, ? FROM parses p
         WHERE p.run_id = ? AND p.status = 'succeeded' AND p.page_id IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM verdicts v WHERE v.run_id = p.run_id AND v.page_id = p.page_id)`,
      )
        .bind(SKIPPED, runId, JSON.stringify(state.pending))
        .run(),
    );
    yield* attempt("mark skipped pages done", () => events.skip(state.pending));
    yield* Effect.forEach(state.pending, (page) => stopPage(env, `${state.workflow}-${page}`), {
      concurrency: 10,
      discard: true,
    });
  }
  if (!(yield* wakeWorkflow(env, state.workflow))) {
    yield* attempt("summarize", () => summarizeRun(env, runId));
    yield* logged(
      attempt("notify done", () => events.runDone("succeeded")),
      "Run done event failed",
      runId,
    );
  }
  return { skipped: state.pending.length };
});
