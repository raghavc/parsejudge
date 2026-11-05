/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));

const { RunEvents } = await import("../src/events.ts");
const { continueRun, NOT_RECORDED, reconcileRun, SKIPPED, summarizeRun } = await import("../src/run.ts");

/** The slice of D1 that finalize.ts uses, over node:sqlite. */
const d1 = (db: DatabaseSync) => {
  const statement = (sql: string, args: ReadonlyArray<unknown> = []) => ({
    bind: (...next: ReadonlyArray<unknown>) => statement(sql, next),
    first: async () => (db.prepare(sql).get(...(args as [])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as [])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as [])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReadonlyArray<ReturnType<typeof statement>>) => Promise.all(statements.map((s) => s.run())),
  };
};

/** Durable Object storage in memory. */
const storage = () => {
  const map = new Map<string, unknown>();
  return {
    get: async (key: string) => map.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [k, v] of typeof key === "string" ? [[key, value] as const] : Object.entries(key)) map.set(k, v);
    },
    delete: async (keys: string | ReadonlyArray<string>) => {
      for (const k of [keys].flat()) map.delete(k);
    },
    list: async ({ prefix }: { prefix: string }) => new Map([...map].filter(([k]) => k.startsWith(prefix))),
  };
};

const migrations = join(import.meta.dirname, "../migrations");
let db: DatabaseSync;
let env: Env;
let events: InstanceType<typeof RunEvents>;
let runWorkflow: { status: string | null; sendEvent: ReturnType<typeof vi.fn> };
let terminated: Array<string>;

beforeEach(async () => {
  db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(join(migrations, file), "utf8"));
  db.exec(`
    INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@b.c', 0);
    INSERT INTO documents (id, user_id, filename, format, sha256, page_count, created_at) VALUES ('d1', 'u1', 'a.pdf', 'pdf', 'x', 2, 0);
    INSERT INTO pages (id, document_id, page_index) VALUES ('d1-0', 'd1', 0), ('d1-1', 'd1', 1);
    INSERT INTO runs (id, user_id, share_id, status, preset_ids, judge_version, judge_model, created_at)
      VALUES ('r1', 'u1', 's1', 'running', '["a","b"]', 'v', 'm', 0);
    INSERT INTO run_documents (run_id, document_id) VALUES ('r1', 'd1');
    INSERT INTO run_credentials (run_id, provider, iv, ciphertext) VALUES ('r1', 'p', 'iv', 'c');
    INSERT INTO parses (run_id, page_id, preset_id, status, latency_ms) VALUES ('r1', 'd1-0', 'a', 'succeeded', 1000), ('r1', 'd1-0', 'b', 'succeeded', 2000);
    INSERT INTO verdicts (run_id, page_id, preset_id, score, reasoning, errors) VALUES ('r1', 'd1-0', 'a', 9, 'ok', '[]'), ('r1', 'd1-0', 'b', 6, 'ok', '[]');
    -- d1-1 was still parsing preset b when the run stalled.
    INSERT INTO parses (run_id, page_id, preset_id, status, latency_ms) VALUES ('r1', 'd1-1', 'a', 'succeeded', 1500);
  `);
  runWorkflow = { status: "waiting", sendEvent: vi.fn(async () => {}) };
  terminated = [];
  env = {
    DB: d1(db),
    RUN_EVENTS: { idFromName: (name: string) => name, get: () => events },
    RUN_WORKFLOW: {
      get: async (id: string) => {
        if (runWorkflow.status === null) throw new Error(`instance.not_found: ${id}`);
        return { status: async () => ({ status: runWorkflow.status }), sendEvent: runWorkflow.sendEvent };
      },
    },
    PAGE_WORKFLOW: {
      get: async (id: string) => ({
        status: async () => ({ status: "waiting" }),
        terminate: async () => void terminated.push(id),
      }),
    },
  } as unknown as Env;
  events = new RunEvents({ storage: storage(), getWebSockets: () => [] } as never, env);
  await events.start("r1", 2);
  await events.pageDone("d1-0");
});

const parses = () => db.prepare("SELECT page_id, preset_id, status, error FROM parses ORDER BY page_id, preset_id").all();
const run = () => db.prepare("SELECT status, error, summary FROM runs WHERE id = 'r1'").get() as Record<string, string | null>;

describe("continueRun", () => {
  it("skips the missing page and lets the waiting workflow summarize", async () => {
    expect(await Effect.runPromise(continueRun(env, "r1"))).toEqual({ skipped: 1 });

    expect(parses()).toContainEqual({ page_id: "d1-1", preset_id: "b", status: "failed", error: SKIPPED });
    expect(parses()).toContainEqual({ page_id: "d1-1", preset_id: "a", status: "succeeded", error: null });
    // d1-1 has a finished parse but no verdict: the report must show it as unjudged, not silently drop it.
    expect(db.prepare("SELECT page_id, error FROM judge_failures").all()).toEqual([{ page_id: "d1-1", error: SKIPPED }]);
    expect(await events.counts()).toEqual({ done: 2, total: 2 });
    expect(terminated).toEqual(["r1-d1-1"]);
    expect(runWorkflow.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "pages-done" }));
    expect(run().status).toBe("running");

    // The woken workflow summarizes; skipped parses are not failures of the parser.
    await Effect.runPromise(summarizeRun(env, "r1"));
    const summary = JSON.parse(run().summary ?? "null") as {
      skippedPages: number;
      presets: Array<{ presetId: string; failedPages: number; skippedPages: number }>;
    };
    expect(run().status).toBe("succeeded");
    expect(summary.presets.find((p) => p.presetId === "b")).toMatchObject({ failedPages: 0, skippedPages: 1 });
    // The report must say a page was skipped instead of looking complete.
    expect(summary.skippedPages).toBe(1);

    // Idempotent.
    expect(await Effect.runPromise(continueRun(env, "r1"))).toEqual({ skipped: 0 });
    expect(parses()).toHaveLength(4);
  });

  it("counts a cell with no stored parse as a failed parse when summarizing", async () => {
    await Effect.runPromise(summarizeRun(env, "r1"));

    expect(parses()).toContainEqual({ page_id: "d1-1", preset_id: "b", status: "failed", error: NOT_RECORDED });
    const summary = JSON.parse(run().summary ?? "null") as { presets: Array<{ presetId: string; failedPages: number }> };
    expect(summary.presets.find((p) => p.presetId === "b")?.failedPages).toBe(1);
  });

  it("summarizes directly when the run workflow is gone", async () => {
    db.exec("UPDATE runs SET status = 'failed', error = '1 of 2 pages did not finish within 6 hours.' WHERE id = 'r1'");
    runWorkflow.status = null;

    expect(await Effect.runPromise(continueRun(env, "r1"))).toEqual({ skipped: 1 });

    expect(run()).toMatchObject({ status: "succeeded", error: null });
    expect(run().summary).not.toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM run_credentials").get()).toEqual({ n: 0 });
    expect(runWorkflow.sendEvent).not.toHaveBeenCalled();
  });
});

describe("reconcileRun", () => {
  it("marks a running run failed once its run workflow has errored, and leaves a live one alone", async () => {
    expect(await Effect.runPromise(reconcileRun(env, "r1"))).toBe(false);
    expect(run().status).toBe("running");

    runWorkflow.status = "errored";
    expect(await Effect.runPromise(reconcileRun(env, "r1"))).toBe(true);
    expect(run()).toMatchObject({ status: "failed", error: "Run workflow errored: no error message" });
  });
});

describe("RunEvents.reopen", () => {
  it("does not reopen pages again when the fan-out step retries", async () => {
    await events.pageDone("d1-1");
    await events.reopen("retry-1", ["d1-1"]);
    await events.pageDone("d1-1");
    await events.reopen("retry-1", ["d1-1"]);
    expect(await events.counts()).toEqual({ done: 2, total: 2 });
  });
});
