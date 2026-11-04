import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export type RunEvent =
  | {
      readonly type: "progress";
      readonly done: number;
      readonly total: number;
      readonly status: string | null;
      readonly cells: ReadonlyArray<CellDone>;
      readonly started: ReadonlyArray<string>;
    }
  | { readonly type: "parse_started"; readonly presetId: string }
  | ({ readonly type: "parse_done" } & CellDone)
  | { readonly type: "page_done"; readonly pageId: string; readonly done: number; readonly total: number }
  | { readonly type: "run_done"; readonly status: "succeeded" | "failed" };

/** One finished (page, preset) parse. `latencyMs` is null when the parse failed. */
export interface CellDone {
  readonly presetId: string;
  readonly pageId: string;
  readonly ok: boolean;
  readonly latencyMs: number | null;
}

/** Durable Object storage reads and writes take at most 128 keys. */
const chunks = <A>(items: ReadonlyArray<A>): Array<Array<A>> =>
  Array.from({ length: Math.ceil(items.length / 128) }, (_, i) => items.slice(i * 128, (i + 1) * 128));

/** One instance per run. Counts finished pages, wakes the run workflow, and pushes progress over WebSocket. */
export class RunEvents extends DurableObject<Env> {
  async start(runId: string, total: number): Promise<void> {
    await this.ctx.storage.put({ runId, total });
  }

  /**
   * Re-opens finished pages for a retry; `pages-done` then goes to the retry's workflow instance. Idempotent per
   * workflow: a retried call must not re-open pages that already finished again, or they would never report.
   */
  async reopen(workflowId: string, pageIds: ReadonlyArray<string>): Promise<void> {
    if ((await this.ctx.storage.get<string>("workflow")) === workflowId) return;
    for (const keys of chunks(pageIds.map((id) => `page:${id}`))) await this.ctx.storage.delete(keys);
    await this.ctx.storage.put("workflow", workflowId);
  }

  /** Idempotent: a retried call does not count or broadcast the page twice, but does resend `pages-done`. */
  async pageDone(pageId: string): Promise<void> {
    const runId = await this.ctx.storage.get<string>("runId");
    const total = (await this.ctx.storage.get<number>("total")) ?? 0;
    const known = (await this.ctx.storage.get<boolean>(`page:${pageId}`)) === true;
    if (!known) await this.ctx.storage.put(`page:${pageId}`, true);
    const done = (await this.ctx.storage.list({ prefix: "page:" })).size;
    if (!known) this.broadcast({ type: "page_done", pageId, done, total });
    if (runId !== undefined && done === total) {
      await (await this.env.RUN_WORKFLOW.get(await this.workflow(runId))).sendEvent({ type: "pages-done", payload: { done } });
    }
  }

  /** Pages done and pages started; `total` is null before the run fans out. */
  async counts(): Promise<{ readonly done: number; readonly total: number | null }> {
    const done = (await this.ctx.storage.list({ prefix: "page:" })).size;
    return { done, total: (await this.ctx.storage.get<number>("total")) ?? null };
  }

  /** The given pages that have not reported done, and the workflow waiting on them. Null before the run fans out. */
  async pending(pageIds: ReadonlyArray<string>): Promise<{ readonly workflow: string; readonly pending: Array<string> } | null> {
    const runId = await this.ctx.storage.get<string>("runId");
    if (runId === undefined) return null;
    const done = await this.ctx.storage.list({ prefix: "page:" });
    return { workflow: await this.workflow(runId), pending: pageIds.filter((id) => !done.has(`page:${id}`)) };
  }

  /** Marks skipped pages done without sending `pages-done`; Continue decides how the run finishes. Idempotent. */
  async skip(pageIds: ReadonlyArray<string>): Promise<void> {
    const done = await this.ctx.storage.list({ prefix: "page:" });
    const fresh = pageIds.filter((id) => !done.has(`page:${id}`));
    for (const ids of chunks(fresh)) await this.ctx.storage.put(Object.fromEntries(ids.map((id) => [`page:${id}`, true])));
    const total = (await this.ctx.storage.get<number>("total")) ?? 0;
    for (const [i, pageId] of fresh.entries()) this.broadcast({ type: "page_done", pageId, done: done.size + i + 1, total });
  }

  /** Marks the preset as sending requests. Only the first call per preset broadcasts. */
  async parseStarted(presetId: string): Promise<void> {
    const key = `started:${presetId}`;
    if ((await this.ctx.storage.get<boolean>(key)) === true) return;
    await this.ctx.storage.put(key, true);
    this.broadcast({ type: "parse_started", presetId });
  }

  /** Idempotent: a retried call does not broadcast the cell twice. */
  async parseDone(cell: CellDone): Promise<void> {
    const key = `cell:${cell.presetId}:${cell.pageId}`;
    if ((await this.ctx.storage.get<CellDone>(key)) !== undefined) return;
    await this.ctx.storage.put(key, cell);
    this.broadcast({ type: "parse_done", ...cell });
  }

  async runDone(status: "succeeded" | "failed"): Promise<void> {
    await this.ctx.storage.put("status", status);
    this.broadcast({ type: "run_done", status });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(await this.progress()));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sent on connect so a late subscriber never misses state. */
  private async progress(): Promise<RunEvent> {
    const total = (await this.ctx.storage.get<number>("total")) ?? 0;
    const done = (await this.ctx.storage.list({ prefix: "page:" })).size;
    const cells = [...(await this.ctx.storage.list<CellDone>({ prefix: "cell:" })).values()];
    const started = [...(await this.ctx.storage.list({ prefix: "started:" })).keys()].map((k) => k.slice("started:".length));
    return { type: "progress", done, total, status: (await this.ctx.storage.get<string>("status")) ?? null, cells, started };
  }

  private async workflow(runId: string): Promise<string> {
    return (await this.ctx.storage.get<string>("workflow")) ?? runId;
  }

  private broadcast(event: RunEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
