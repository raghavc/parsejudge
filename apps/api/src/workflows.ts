import { JUDGE_VERSION, judgePage, type PageResult, splitPages, summarize } from "@evalmydocs/core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { Effect } from "effect";
import type { Env } from "./env.ts";
import type { RunEvents } from "./events.ts";
import { documentKey, markdownKey, pageId, pagePdfKey, pagePngKey } from "./keys.ts";
import { renderFirstPagePng } from "./render.ts";
import { type Cell, pollCell, runStep, saveFailure, submitCell } from "./run.ts";

export interface RunWorkflowParams {
  readonly runId: string;
}

export interface PageWorkflowParams {
  readonly runId: string;
  readonly pageId: string;
  readonly presetIds: ReadonlyArray<string>;
}

const RETRY: WorkflowStepConfig = { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const MAX_POLLS = 40;
const pollDelaySeconds = (attempt: number) => Math.min(2 ** attempt * 2, 60);

const events = (env: Env, runId: string) =>
  env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(runId)) as unknown as DurableObjectStub<RunEvents>;

/** One run: render pages, fan out one PageWorkflow per page, wait for all, then summarize. */
export class RunWorkflow extends WorkflowEntrypoint<Env, RunWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<RunWorkflowParams>>, step: WorkflowStep) {
    const { runId } = event.payload;
    try {
      const run = await step.do("load run", async () => {
        await this.env.DB.prepare("UPDATE runs SET status = 'running' WHERE id = ?").bind(runId).run();
        const row = await this.env.DB.prepare("SELECT preset_ids FROM runs WHERE id = ?").bind(runId).first<{ preset_ids: string }>();
        const documents = await this.env.DB.prepare("SELECT document_id FROM run_documents WHERE run_id = ? ORDER BY document_id")
          .bind(runId)
          .all<{ document_id: string }>();
        return { presetIds: JSON.parse(row?.preset_ids ?? "[]") as Array<string>, documentIds: documents.results.map((d) => d.document_id) };
      });

      const pageIds: Array<string> = [];
      for (const documentId of run.documentIds) {
        pageIds.push(...(await step.do(`prepare ${documentId}`, RETRY, () => this.preparePages(documentId))));
      }

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
    } catch (error) {
      await step.do("record failure", async () => {
        await this.finish(runId, "failed", error instanceof Error ? error.message : String(error));
        await events(this.env, runId).runDone("failed");
      });
    }
  }

  /** Splits the document into single-page PDFs and PNGs once; later runs reuse them. */
  private async preparePages(documentId: string): Promise<Array<string>> {
    const document = await this.env.DB.prepare("SELECT page_count FROM documents WHERE id = ?").bind(documentId).first<{ page_count: number }>();
    const count = document?.page_count ?? 0;
    const ids = Array.from({ length: count }, (_, index) => pageId(documentId, index));
    const rendered = await this.env.DB.prepare("SELECT COUNT(*) AS n FROM pages WHERE document_id = ? AND rendered = 1")
      .bind(documentId)
      .first<{ n: number }>();
    if (rendered?.n === count) return ids;
    const source = await this.env.BLOBS.get(documentKey(documentId));
    if (source === null) throw new Error(`Missing document ${documentId}`);
    const pages = await Effect.runPromise(splitPages(new Uint8Array(await source.arrayBuffer()), count));
    for (const [index, pdf] of pages.entries()) {
      const id = pageId(documentId, index);
      await this.env.BLOBS.put(pagePdfKey(id), pdf);
      await this.env.BLOBS.put(pagePngKey(id), await renderFirstPagePng(pdf));
      await this.env.DB.prepare(
        "INSERT INTO pages (id, document_id, page_index, rendered) VALUES (?, ?, ?, 1) ON CONFLICT (id) DO UPDATE SET rendered = 1",
      )
        .bind(id, documentId, index)
        .run();
    }
    return ids;
  }

  private async summarize(runId: string): Promise<void> {
    const parses = await this.env.DB.prepare(
      `SELECT p.page_id, p.preset_id, p.status, p.latency_ms, p.cost_usd, p.cost_source, v.score, v.reasoning, v.errors
       FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ?`,
    )
      .bind(runId)
      .all<Record<string, string | number | null>>();
    const results: Array<PageResult> = parses.results.map((row) => ({
      pageId: String(row.page_id),
      presetId: String(row.preset_id),
      status: row.status === "succeeded" ? "succeeded" : "failed",
      ...(typeof row.latency_ms === "number" ? { latencyMs: row.latency_ms } : {}),
      ...(typeof row.cost_usd === "number"
        ? { cost: { usd: row.cost_usd, source: row.cost_source === "provider" ? "provider" : "list_price" } }
        : {}),
      ...(typeof row.score === "number"
        ? { verdict: { presetId: String(row.preset_id), score: row.score, reasoning: String(row.reasoning), errors: JSON.parse(String(row.errors)) } }
        : {}),
    }));
    await this.env.DB.prepare("UPDATE runs SET summary = ? WHERE id = ?").bind(JSON.stringify(summarize(results)), runId).run();
    await this.finish(runId, "succeeded", null);
  }

  private async finish(runId: string, status: "succeeded" | "failed", error: string | null): Promise<void> {
    await this.env.DB.batch([
      this.env.DB.prepare("UPDATE runs SET status = ?, error = ?, completed_at = ? WHERE id = ?").bind(status, error, Date.now(), runId),
      this.env.DB.prepare("DELETE FROM run_credentials WHERE run_id = ?").bind(runId),
    ]);
  }
}

/** One page of one run: parse with every preset in parallel, then judge them together. */
export class PageWorkflow extends WorkflowEntrypoint<Env, PageWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<PageWorkflowParams>>, step: WorkflowStep) {
    const { runId, pageId: page, presetIds } = event.payload;
    await Promise.all(presetIds.map((presetId) => this.parse(step, { runId, pageId: page, presetId })));
    await step.do("judge", RETRY, () => this.judge(runId, page));
    await step.do("report", () => events(this.env, runId).pageDone(page));
  }

  /** Submit once, then poll with durable sleeps. A failure is recorded, not thrown, so other presets still count. */
  private async parse(step: WorkflowStep, cell: Cell): Promise<void> {
    const name = cell.presetId;
    try {
      const { job, startedAt } = await step.do(`submit ${name}`, RETRY, () => submitCell(this.env, cell));
      if (job === null) return;
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await step.sleep(`wait ${name} ${attempt}`, `${pollDelaySeconds(attempt)} seconds`);
        if (await step.do(`poll ${name} ${attempt}`, RETRY, () => pollCell(this.env, cell, job, startedAt))) return;
      }
      throw new Error("Timed out waiting for the provider");
    } catch (error) {
      await step.do(`record failure ${name}`, async () => {
        await saveFailure(this.env, cell, error instanceof Error ? error.message : String(error));
      });
    }
  }

  private async judge(runId: string, page: string): Promise<void> {
    const rows = await this.env.DB.prepare("SELECT preset_id FROM parses WHERE run_id = ? AND page_id = ? AND status = 'succeeded'")
      .bind(runId, page)
      .all<{ preset_id: string }>();
    if (rows.results.length === 0) return;
    const markdownByPreset: Record<string, string> = {};
    for (const { preset_id } of rows.results) {
      markdownByPreset[preset_id] = (await (await this.env.BLOBS.get(markdownKey(runId, page, preset_id)))?.text()) ?? "";
    }
    const image = await this.env.BLOBS.get(pagePngKey(page));
    if (image === null) throw new Error(`Missing image for ${page}`);
    const verdicts = await runStep(
      judgePage(
        {
          apiKey: this.env.OPENAI_API_KEY,
          model: this.env.JUDGE_MODEL,
          reasoningEffort: this.env.JUDGE_REASONING_EFFORT,
          baseUrl: this.env.JUDGE_BASE_URL,
        },
        { pageId: page, imagePng: new Uint8Array(await image.arrayBuffer()), markdownByPreset },
      ),
    );
    await this.env.DB.batch(
      verdicts.map((verdict) =>
        this.env.DB.prepare("INSERT OR REPLACE INTO verdicts (run_id, page_id, preset_id, score, reasoning, errors) VALUES (?, ?, ?, ?, ?, ?)").bind(
          runId,
          page,
          verdict.presetId,
          verdict.score,
          verdict.reasoning,
          JSON.stringify(verdict.errors),
        ),
      ),
    );
  }
}

export { JUDGE_VERSION };
