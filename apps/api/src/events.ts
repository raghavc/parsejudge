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

/** One instance per run. Counts finished pages, wakes the run workflow, and pushes progress over WebSocket. */
export class RunEvents extends DurableObject<Env> {
  async start(runId: string, total: number): Promise<void> {
    await this.ctx.storage.put({ runId, total });
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
      await (await this.env.RUN_WORKFLOW.get(runId)).sendEvent({ type: "pages-done", payload: { done } });
    }
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

  private broadcast(event: RunEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
