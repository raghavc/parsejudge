import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { JUDGE_VERSION, judgePage, type PageResult, splitPages, summarize } from "@parsejudge/core";
import { Effect } from "effect";
import { checkJudgeBudget } from "./budget.ts";
import type { Env } from "./env.ts";
import type { RunEvents } from "./events.ts";
import { documentKey, markdownKey, pageId, pagePdfKey, pagePngKey } from "./keys.ts";
import { writeLocations } from "./locate.ts";
import { writePageNote } from "./note.ts";
import { renderFirstPagePng } from "./render.ts";
import { type Cell, judgePool, type Pool, pollCell, providerPool, runStep, saveFailure, submitCell } from "./run.ts";
import { MAX_POLLS, pollDelayMs } from "./schedule.ts";
import type { ProviderSlots } from "./slots.ts";
import { openRouterUsage, recordUsage } from "./usage.ts";

export interface RunWorkflowParams {
  readonly runId: string;
}

export interface PageWorkflowParams {
  readonly runId: string;
  readonly pageId: string;
  readonly presetIds: ReadonlyArray<string>;
}

const RETRY: WorkflowStepConfig = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };

const events = (env: Env, runId: string) =>
  env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(runId)) as unknown as DurableObjectStub<RunEvents>;

const slots = (env: Env, pool: string) =>
  env.PROVIDER_SLOTS.get(env.PROVIDER_SLOTS.idFromName(pool)) as unknown as DurableObjectStub<ProviderSlots>;

/** Renders a page's PNG once; later runs reuse it. */
const renderPage = async (env: Env, page: string): Promise<void> => {
  if ((await env.BLOBS.head(pagePngKey(page))) !== null) return;
  const pdf = await env.BLOBS.get(pagePdfKey(page));
  if (pdf === null) throw new Error(`Missing page ${page}`);
  await env.BLOBS.put(pagePngKey(page), await renderFirstPagePng(new Uint8Array(await pdf.arrayBuffer())));
  await env.DB.prepare("UPDATE pages SET rendered = 1 WHERE id = ?").bind(page).run();
};

export interface DocumentWorkflowParams {
  readonly documentId: string;
  readonly pageCount: number;
}

/** Started by each upload, so a document's page images are ready before a run starts. */
export class DocumentWorkflow extends WorkflowEntrypoint<Env, DocumentWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<DocumentWorkflowParams>>, step: WorkflowStep) {
    const { documentId, pageCount } = event.payload;
    for (let index = 0; index < pageCount; index++) {
      await step.do(`render ${index}`, RETRY, () => renderPage(this.env, pageId(documentId, index)));
    }
  }
}

/** One run: split documents into pages, fan out one PageWorkflow per page, wait for all, then summarize. */
export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<RunWorkflowParams>>, step: WorkflowStep) {
    const { runId } = event.payload;
    try {
      const run = await step.do("load run", async () => {
        await this.env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(runId).run();
        const row = await this.env.DB.prepare("SELECT preset_ids FROM runs WHERE id = ?")
          .bind(runId)
          .first<{ preset_ids: string }>();
        const documents = await this.env.DB.prepare("SELECT document_id FROM run_documents WHERE run_id = ? ORDER BY document_id")
          .bind(runId)
          .all<{ document_id: string }>();
        return {
          presetIds: JSON.parse(row?.preset_ids ?? "[]") as Array<string>,
          documentIds: documents.results.map((d) => d.document_id),
        };
      });

      const pageIds = (
        await Promise.all(
          run.documentIds.map((documentId) => step.do(`prepare ${documentId}`, RETRY, () => this.preparePages(documentId))),
        )
      ).flat();

      await step.do("fan out", RETRY, async () => {
        await events(this.env, runId).start(runId, pageIds.length);
        for (let offset = 0; offset < pageIds.length; offset += 100) {
          await this.env.PAGE_WORKFLOW.createBatch(
            pageIds.slice(offset, offset + 100).map((id) => ({
              id: `${runId}-${id}`,
              params: { runId, pageId: id, presetIds: run.presetIds },
            })),
          );
        }
      });

      await step.waitForEvent("pages done", { type: "pages-done", timeout: "6 hours" });
      await step.do("summarize", RETRY, () => this.summarize(runId));
      await step.do("notify done", () => events(this.env, runId).runDone("succeeded"));
      await step
        .do("check judge budget", RETRY, () => checkJudgeBudget(this.env))
        .catch((error: unknown) => {
          console.error("Judge budget check failed", error);
        });
    } catch (error) {
      await step.do("record failure", async () => {
        await this.finish(runId, "failed", error instanceof Error ? error.message : String(error));
        await events(this.env, runId).runDone("failed");
      });
    }
  }

  /** Upload already splits the document; this covers an upload whose split did not finish. */
  private async preparePages(documentId: string): Promise<Array<string>> {
    const document = await this.env.DB.prepare("SELECT page_count FROM documents WHERE id = ?")
      .bind(documentId)
      .first<{ page_count: number }>();
    const count = document?.page_count ?? 0;
    const ids = Array.from({ length: count }, (_, index) => pageId(documentId, index));
    const split = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE document_id = ?")
      .bind(documentId)
      .first<{ n: number }>();
    if (split?.n === count) return ids;
    const source = await this.env.BLOBS.get(documentKey(documentId));
    if (source === null) throw new Error(`Missing document ${documentId}`);
    const pages = await Effect.runPromise(splitPages(new Uint8Array(await source.arrayBuffer()), count));
    for (const [index, pdf] of pages.entries()) {
      const id = pageId(documentId, index);
      await this.env.BLOBS.put(pagePdfKey(id), pdf);
      await this.env.DB.prepare("INSERT OR IGNORE INTO pages (id, document_id, page_index, rendered) VALUES (?, ?, ?, 0)")
        .bind(id, documentId, index)
        .run();
    }
    return ids;
  }

  private async summarize(runId: string): Promise<void> {
    const parses = await this.env.DB.prepare(
      `SELECT p.page_id, p.preset_id, p.status, p.latency_ms, p.queue_ms, p.cost_usd, p.cost_source, v.score, v.reasoning, v.errors
       FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ?`,
    )
      .bind(runId)
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
    await this.env.DB.prepare("UPDATE runs SET summary = ? WHERE id = ?")
      .bind(JSON.stringify(summarize(results)), runId)
      .run();
    await this.finish(runId, "succeeded", null);
  }

  private async finish(runId: string, status: "succeeded" | "failed", error: string | null): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").bind(
        status,
        error,
        Date.now(),
        runId,
      ),
      this.env.DB.prepare("DELETE FROM run_credentials WHERE run_id = ?").bind(runId),
    ]);
  }
}

/**
 * One page of one run: render it, parse it with every preset in parallel, then judge the parses together.
 * Every provider call and the judge call hold a slot in their pool, so each pool stays under its limit.
 */
export class PageWorkflow extends WorkflowEntrypoint<Env, PageWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<PageWorkflowParams>>, step: WorkflowStep) {
    const { runId, pageId: page, presetIds } = event.payload;
    await step.do("render", RETRY, () => renderPage(this.env, page));
    await Promise.all(presetIds.map((presetId) => this.parse(step, event.instanceId, { runId, pageId: page, presetId })));
    try {
      const pool = judgePool(this.env);
      await this.withSlot(step, event.instanceId, "judge", pool, () => step.do("judge", RETRY, () => this.judge(runId, page)));
    } catch (error) {
      await step.do("record judge failure", async () => {
        await this.env.DB.prepare("INSERT OR REPLACE INTO judge_failures (run_id, page_id, error) VALUES (?, ?, ?)")
          .bind(runId, page, error instanceof Error ? error.message : String(error))
          .run();
      });
    }
    await Promise.all(
      presetIds.map((presetId) =>
        step
          .do(`locate ${presetId}`, RETRY, () => writeLocations(this.env, runId, page, presetId))
          .catch((error: unknown) => console.error("Locating errors failed", page, presetId, error)),
      ),
    );
    try {
      await step.do("note", RETRY, () => writePageNote(this.env, runId, page));
    } catch (error) {
      console.error("Page note failed", page, error);
    }
    await step.do("report", () => events(this.env, runId).pageDone(page));
  }

  /**
   * Runs `body` while holding a slot in `pool`. When the pool is full the workflow sleeps on an
   * event that the pool sends when a slot frees up. `body` gets the time spent waiting for the slot.
   * The slot is released even when `body` fails.
   */
  private async withSlot<A>(
    step: WorkflowStep,
    instanceId: string,
    label: string,
    pool: Pool,
    body: (queueMs: number) => Promise<A>,
  ) {
    const waiter = { lease: `${instanceId}:${label}`, instanceId, event: `slot-${label}` };
    try {
      const requested = await step.do(`acquire ${label}`, RETRY, async () => ({
        granted: await slots(this.env, pool.name).acquire(pool.limit, waiter),
        at: Date.now(),
      }));
      let grantedAt = requested.at;
      if (!requested.granted) {
        await step.waitForEvent(`slot ${label}`, { type: waiter.event, timeout: "24 hours" });
        grantedAt = await step.do(`granted ${label}`, async () => Date.now());
      }
      return await body(grantedAt - requested.at);
    } finally {
      await step.do(`release ${label}`, RETRY, () => slots(this.env, pool.name).release(waiter.lease));
    }
  }

  /** Submit once, then poll with durable sleeps. A failure is recorded, not thrown, so other presets still count. */
  private async parse(step: WorkflowStep, instanceId: string, cell: Cell): Promise<void> {
    const name = cell.presetId;
    try {
      const pool = await step.do(`pool ${name}`, RETRY, () => providerPool(this.env, cell));
      await this.withSlot(step, instanceId, name, pool, async (queueMs) => {
        const { job, startedAt } = await step.do(`submit ${name}`, RETRY, async () => {
          await events(this.env, cell.runId).parseStarted(cell.presetId);
          return submitCell(this.env, cell, queueMs);
        });
        if (job === null) return;
        for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
          await step.sleep(`wait ${name} ${attempt}`, pollDelayMs(attempt));
          if (await step.do(`poll ${name} ${attempt}`, RETRY, () => pollCell(this.env, cell, job, startedAt, queueMs))) {
            return;
          }
        }
        throw new Error("Timed out waiting for the provider");
      });
    } catch (error) {
      await step.do(`record failure ${name}`, async () => {
        await saveFailure(this.env, cell, error instanceof Error ? error.message : String(error));
      });
    }
    await step.do(`report ${name}`, async () => {
      const row = await this.env.DB.prepare(
        "SELECT status, latency_ms FROM parses WHERE run_id = ? AND page_id = ? AND preset_id = ?",
      )
        .bind(cell.runId, cell.pageId, cell.presetId)
        .first<{ status: string; latency_ms: number | null }>();
      const ok = row?.status === "succeeded";
      await events(this.env, cell.runId).parseDone({
        presetId: cell.presetId,
        pageId: cell.pageId,
        ok,
        latencyMs: ok ? (row?.latency_ms ?? null) : null,
      });
    });
  }

  private async judge(runId: string, page: string): Promise<void> {
    const rows = await this.env.DB.prepare(
      "SELECT preset_id FROM parses WHERE run_id = ? AND page_id = ? AND status = 'succeeded'",
    )
      .bind(runId, page)
      .all<{ preset_id: string }>();
    if (rows.results.length === 0) return;
    const markdownByPreset: Record<string, string> = {};
    for (const { preset_id } of rows.results) {
      markdownByPreset[preset_id] = (await (await this.env.BLOBS.get(markdownKey(runId, page, preset_id)))?.text()) ?? "";
    }
    const image = await this.env.BLOBS.get(pagePngKey(page));
    if (image === null) throw new Error(`Missing image for ${page}`);
    const startedAt = Date.now();
    const verdicts = await runStep(
      judgePage(
        {
          apiKey: this.env.JUDGE_API_KEY,
          model: this.env.JUDGE_MODEL,
          reasoningEffort: this.env.JUDGE_REASONING_EFFORT,
          baseUrl: this.env.JUDGE_BASE_URL,
          onUsage: (usage) =>
            recordUsage(this.env, {
              kind: "judge",
              name: this.env.JUDGE_MODEL,
              runId,
              pageId: page,
              status: "ok",
              latencyMs: Date.now() - startedAt,
              ...openRouterUsage(usage),
            }),
        },
        { pageId: page, imagePng: new Uint8Array(await image.arrayBuffer()), markdownByPreset },
      ),
    );
    await this.env.DB.batch(
      verdicts.map((verdict) =>
        this.env.DB.prepare(
          "INSERT OR REPLACE INTO verdicts (run_id, page_id, preset_id, score, reasoning, errors) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(runId, page, verdict.presetId, verdict.score, verdict.reasoning, JSON.stringify(verdict.errors)),
      ),
    );
  }
}

export { JUDGE_VERSION };
