import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.ts";

export type RunEvent =
  | { readonly type: "page_done"; readonly pageId: string; readonly done: number; readonly total: number }
  | { readonly type: "run_done"; readonly status: "succeeded" | "failed" };

/** One instance per run. Counts finished pages, wakes the run workflow, and pushes progress over WebSocket. */
export class RunEvents extends DurableObject<Env> {
  async start(runId: string, total: number): Promise<void> {
    await this.ctx.storage.put({ runId, total });
  }

  async pageDone(pageId: string): Promise<void> {
    const runId = await this.ctx.storage.get<string>("runId");
    const total = (await this.ctx.storage.get<number>("total")) ?? 0;
    await this.ctx.storage.put(`page:${pageId}`, true);
    const done = (await this.ctx.storage.list({ prefix: "page:" })).size;
    this.broadcast({ type: "page_done", pageId, done, total });
    if (runId !== undefined && done === total) {
      await (await this.env.RUN_WORKFLOW.get(runId)).sendEvent({ type: "pages-done", payload: { done } });
    }
  }

  async runDone(status: "succeeded" | "failed"): Promise<void> {
    this.broadcast({ type: "run_done", status });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(event: RunEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
