import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
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
  private get<A>(key: string) {
    return Effect.promise(() => this.ctx.storage.get<A>(key));
  }

  private list<A>(prefix: string) {
    return Effect.promise(() => this.ctx.storage.list<A>({ prefix }));
  }

  start(runId: string, total: number): Promise<void> {
    return Effect.runPromise(Effect.promise(() => this.ctx.storage.put({ runId, total })));
  }

  /**
   * Re-opens finished pages for a retry; `pages-done` then goes to the retry's workflow instance. Idempotent per
   * workflow: a retried call must not re-open pages that already finished again, or they would never report.
   */
  reopen(workflowId: string, pageIds: ReadonlyArray<string>): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        if ((yield* this.get<string>("workflow")) === workflowId) return;
        for (const keys of chunks(pageIds.map((id) => `page:${id}`))) yield* Effect.promise(() => this.ctx.storage.delete(keys));
        yield* Effect.promise(() => this.ctx.storage.put("workflow", workflowId));
      }),
    );
  }

  /** Idempotent: a retried call does not count or broadcast the page twice, but does resend `pages-done`. */
  pageDone(pageId: string): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const runId = yield* this.get<string>("runId");
        const total = (yield* this.get<number>("total")) ?? 0;
        const known = (yield* this.get<boolean>(`page:${pageId}`)) === true;
        if (!known) yield* Effect.promise(() => this.ctx.storage.put(`page:${pageId}`, true));
        const done = (yield* this.list("page:")).size;
        if (!known) this.broadcast({ type: "page_done", pageId, done, total });
        if (runId !== undefined && done === total) {
          const workflowId = yield* this.workflow(runId);
          const instance = yield* Effect.promise(() => this.env.RUN_WORKFLOW.get(workflowId));
          yield* Effect.promise(() => instance.sendEvent({ type: "pages-done", payload: { done } }));
        }
      }),
    );
  }

  /** Pages done and pages started; `total` is null before the run fans out. */
  counts(): Promise<{ readonly done: number; readonly total: number | null }> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const done = (yield* this.list("page:")).size;
        return { done, total: (yield* this.get<number>("total")) ?? null };
      }),
    );
  }

  /** The given pages that have not reported done, and the workflow waiting on them. Null before the run fans out. */
  pending(pageIds: ReadonlyArray<string>): Promise<{ readonly workflow: string; readonly pending: Array<string> } | null> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const runId = yield* this.get<string>("runId");
        if (runId === undefined) return null;
        const done = yield* this.list("page:");
        return { workflow: yield* this.workflow(runId), pending: pageIds.filter((id) => !done.has(`page:${id}`)) };
      }),
    );
  }

  /** Marks skipped pages done without sending `pages-done`; Continue decides how the run finishes. Idempotent. */
  skip(pageIds: ReadonlyArray<string>): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const done = yield* this.list("page:");
        const fresh = pageIds.filter((id) => !done.has(`page:${id}`));
        for (const ids of chunks(fresh)) {
          yield* Effect.promise(() => this.ctx.storage.put(Object.fromEntries(ids.map((id) => [`page:${id}`, true]))));
        }
        const total = (yield* this.get<number>("total")) ?? 0;
        for (const [i, pageId] of fresh.entries()) this.broadcast({ type: "page_done", pageId, done: done.size + i + 1, total });
      }),
    );
  }

  /** Marks the preset as sending requests. Only the first call per preset broadcasts. */
  parseStarted(presetId: string): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const key = `started:${presetId}`;
        if ((yield* this.get<boolean>(key)) === true) return;
        yield* Effect.promise(() => this.ctx.storage.put(key, true));
        this.broadcast({ type: "parse_started", presetId });
      }),
    );
  }

  /** Idempotent: a retried call does not broadcast the cell twice. */
  parseDone(cell: CellDone): Promise<void> {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const key = `cell:${cell.presetId}:${cell.pageId}`;
        if ((yield* this.get<CellDone>(key)) !== undefined) return;
        yield* Effect.promise(() => this.ctx.storage.put(key, cell));
        this.broadcast({ type: "parse_done", ...cell });
      }),
    );
  }

  runDone(status: "succeeded" | "failed"): Promise<void> {
    return Effect.runPromise(
      Effect.promise(() => this.ctx.storage.put("status", status)).pipe(
        Effect.tap(() => Effect.sync(() => this.broadcast({ type: "run_done", status }))),
      ),
    );
  }

  override fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return Promise.resolve(new Response("Expected WebSocket", { status: 426 }));
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return Effect.runPromise(
      this.progress().pipe(
        Effect.map((progress) => {
          server.send(JSON.stringify(progress));
          return new Response(null, { status: 101, webSocket: client });
        }),
      ),
    );
  }

  /** Sent on connect so a late subscriber never misses state. */
  private progress() {
    return Effect.gen({ self: this }, function* () {
      const total = (yield* this.get<number>("total")) ?? 0;
      const done = (yield* this.list("page:")).size;
      const cells = [...(yield* this.list<CellDone>("cell:")).values()];
      const started = [...(yield* this.list("started:")).keys()].map((k) => k.slice("started:".length));
      const status = (yield* this.get<string>("status")) ?? null;
      return { type: "progress", done, total, status, cells, started } satisfies RunEvent;
    });
  }

  private workflow(runId: string) {
    return this.get<string>("workflow").pipe(Effect.map((workflow) => workflow ?? runId));
  }

  private broadcast(event: RunEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }
}
