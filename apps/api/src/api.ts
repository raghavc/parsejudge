import { env } from "cloudflare:workers";
import { DEFAULT_PRESET_IDS, findPreset, JUDGE_VERSION, PRESETS, sniffFormat, splitPages } from "@parsejudge/core";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/http-api";
import { toPdf } from "./converter.ts";
import { encryptCredentials } from "./credentials.ts";
import type { Env } from "./env.ts";
import { documentKey, markdownKey, sourceKey } from "./keys.ts";

const cf = env as unknown as Env;

const PresetInfo = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  listPriceUsdPerPage: Schema.Number,
  hosted: Schema.Boolean,
  default: Schema.Boolean,
});

const CreateRun = Schema.Struct({
  documentIds: Schema.Array(Schema.String),
  presetIds: Schema.optional(Schema.Array(Schema.String)),
  /** BYOK keys by provider id, e.g. `{ "llamaparse": { "LLAMA_CLOUD_API_KEY": "..." } }`. */
  credentials: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
});

const Run = Schema.Struct({
  id: Schema.String,
  shareId: Schema.String,
  status: Schema.String,
  presetIds: Schema.Array(Schema.String),
  judgeVersion: Schema.String,
  judgeModel: Schema.String,
  summary: Schema.NullOr(Schema.Unknown),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
});

const PageDetail = Schema.Struct({
  pageId: Schema.String,
  parses: Schema.Array(
    Schema.Struct({
      presetId: Schema.String,
      status: Schema.String,
      latencyMs: Schema.NullOr(Schema.Number),
      queueMs: Schema.NullOr(Schema.Number),
      markdown: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      score: Schema.NullOr(Schema.Number),
      reasoning: Schema.NullOr(Schema.String),
      errors: Schema.Unknown,
    }),
  ),
});

export const Api = HttpApi.make("parsejudge")
  .add(HttpApiGroup.make("presets").add(HttpApiEndpoint.get("list", "/v1/presets", { success: Schema.Array(PresetInfo) })))
  .add(
    HttpApiGroup.make("documents").add(
      HttpApiEndpoint.post("upload", "/v1/documents", {
        query: { filename: Schema.optional(Schema.String) },
        success: Schema.Struct({ documentId: Schema.String, pageCount: Schema.Number }),
        error: [HttpApiError.BadRequest, HttpApiError.Unauthorized, HttpApiError.ServiceUnavailable],
      }),
    ),
  )
  .add(
    HttpApiGroup.make("runs")
      .add(
        HttpApiEndpoint.post("create", "/v1/runs", {
          payload: CreateRun,
          success: Schema.Struct({ runId: Schema.String, shareId: Schema.String }),
          error: [HttpApiError.BadRequest, HttpApiError.Unauthorized],
        }),
      )
      .add(
        HttpApiEndpoint.get("get", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          success: Run,
          error: HttpApiError.NotFound,
        }),
      )
      .add(
        HttpApiEndpoint.get("shared", "/v1/share/:shareId", {
          params: { shareId: Schema.String },
          success: Run,
          error: HttpApiError.NotFound,
        }),
      )
      .add(
        HttpApiEndpoint.get("page", "/v1/runs/:runId/pages/:pageId", {
          params: { runId: Schema.String, pageId: Schema.String },
          success: PageDetail,
          error: HttpApiError.NotFound,
        }),
      ),
  );

const query = <A>(promise: () => Promise<A>) => Effect.promise(promise);

/**
 * The signed-in user. Placeholder until email auth lands: trusts the `x-parsejudge-user` header
 * when AUTH_MODE is "dev", and rejects every request otherwise.
 */
const currentUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const email = request.headers["x-parsejudge-user"];
  if (cf.AUTH_MODE !== "dev" || email === undefined || !email.includes("@")) {
    return yield* new HttpApiError.Unauthorized({});
  }
  const id = crypto.randomUUID();
  yield* query(() =>
    cf.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
      .bind(id, email.toLowerCase(), Date.now())
      .run(),
  );
  const user = yield* query(() =>
    cf.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first<{ id: string }>(),
  );
  return user?.id ?? id;
});

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

type RunRow = {
  id: string;
  share_id: string;
  status: string;
  preset_ids: string;
  judge_version: string;
  judge_model: string;
  summary: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
};

const toRun = (row: RunRow) => ({
  id: row.id,
  shareId: row.share_id,
  status: row.status,
  presetIds: JSON.parse(row.preset_ids) as Array<string>,
  judgeVersion: row.judge_version,
  judgeModel: row.judge_model,
  summary: row.summary === null ? null : (JSON.parse(row.summary) as unknown),
  error: row.error,
  createdAt: row.created_at,
  completedAt: row.completed_at,
});

const findRun = (column: "id" | "share_id", value: string) =>
  query(() => cf.DB.prepare(`SELECT * FROM runs WHERE ${column} = ?`).bind(value).first<RunRow>()).pipe(
    Effect.flatMap((row) => (row === null ? Effect.fail(new HttpApiError.NotFound({})) : Effect.succeed(toRun(row)))),
  );

const PresetsLive = HttpApiBuilder.group(Api, "presets", (handlers) =>
  handlers.handle("list", () =>
    Effect.succeed(
      PRESETS.map((preset) => ({
        id: preset.id,
        provider: preset.provider,
        label: preset.label,
        listPriceUsdPerPage: preset.listPriceUsdPerPage,
        hosted: preset.hosted,
        default: DEFAULT_PRESET_IDS.includes(preset.id),
      })),
    ),
  ),
);

const DocumentsLive = HttpApiBuilder.group(Api, "documents", (handlers) =>
  handlers.handle("upload", ({ query: { filename } }) =>
    Effect.gen(function* () {
      const userId = yield* currentUser;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const bytes = new Uint8Array(yield* request.arrayBuffer.pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))));
      const format = yield* sniffFormat(bytes).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})));
      const pdf = yield* toPdf(cf, format, bytes).pipe(
        Effect.mapError((error) =>
          error._tag === "InvalidDocument" ? new HttpApiError.BadRequest({}) : new HttpApiError.ServiceUnavailable({}),
        ),
      );
      const pages = yield* splitPages(pdf, Number(cf.MAX_PAGES_PER_RUN)).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      );
      const documentId = crypto.randomUUID();
      yield* query(() => cf.BLOBS.put(sourceKey(documentId, format), bytes));
      yield* query(() => cf.BLOBS.put(documentKey(documentId), pdf));
      yield* query(async () =>
        cf.DB.prepare(
          "INSERT INTO documents (id, user_id, filename, format, sha256, page_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(documentId, userId, filename ?? `document.${format}`, format, await sha256(bytes), pages.length, Date.now())
          .run(),
      );
      return { documentId, pageCount: pages.length };
    }),
  ),
);

const RunsLive = HttpApiBuilder.group(Api, "runs", (handlers) =>
  handlers
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* currentUser;
        const presetIds = payload.presetIds ?? DEFAULT_PRESET_IDS;
        if (payload.documentIds.length === 0 || presetIds.length === 0) return yield* new HttpApiError.BadRequest({});
        for (const id of presetIds) {
          const preset = findPreset(id);
          if (preset === undefined) return yield* new HttpApiError.BadRequest({});
          if (!preset.hosted && payload.credentials?.[preset.provider] === undefined)
            return yield* new HttpApiError.BadRequest({});
        }
        const owned = yield* query(() =>
          cf.DB.prepare(
            `SELECT COALESCE(SUM(page_count), 0) AS pages, COUNT(*) AS n FROM documents
             WHERE user_id = ? AND id IN (${payload.documentIds.map(() => "?").join(", ")})`,
          )
            .bind(userId, ...payload.documentIds)
            .first<{ pages: number; n: number }>(),
        );
        if (owned?.n !== payload.documentIds.length || owned.pages > Number(cf.MAX_PAGES_PER_RUN)) {
          return yield* new HttpApiError.BadRequest({});
        }
        const runId = crypto.randomUUID();
        const shareId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        const credentials = yield* query(() =>
          Promise.all(
            Object.entries(payload.credentials ?? {}).map(async ([provider, values]) => ({
              provider,
              ...(await encryptCredentials(cf.CREDENTIALS_KEY, runId, values)),
            })),
          ),
        );
        yield* query(() =>
          cf.DB.batch([
            cf.DB.prepare(
              `INSERT INTO runs (id, user_id, share_id, status, preset_ids, judge_version, judge_model, created_at)
               VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
            ).bind(runId, userId, shareId, JSON.stringify(presetIds), JUDGE_VERSION, cf.JUDGE_MODEL, Date.now()),
            ...payload.documentIds.map((documentId) =>
              cf.DB.prepare("INSERT INTO run_documents (run_id, document_id) VALUES (?, ?)").bind(runId, documentId),
            ),
            ...credentials.map((c) =>
              cf.DB.prepare("INSERT INTO run_credentials (run_id, provider, iv, ciphertext) VALUES (?, ?, ?, ?)").bind(
                runId,
                c.provider,
                c.iv,
                c.ciphertext,
              ),
            ),
          ]),
        );
        yield* query(() => cf.RUN_WORKFLOW.create({ id: runId, params: { runId } }));
        return { runId, shareId };
      }),
    )
    .handle("get", ({ params }) => findRun("id", params.runId))
    .handle("shared", ({ params }) => findRun("share_id", params.shareId))
    .handle("page", ({ params }) =>
      Effect.gen(function* () {
        const rows = yield* query(() =>
          cf.DB.prepare(
            `SELECT p.preset_id, p.status, p.latency_ms, p.queue_ms, p.error, v.score, v.reasoning, v.errors
             FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ? AND p.page_id = ?`,
          )
            .bind(params.runId, params.pageId)
            .all<{
              preset_id: string;
              status: string;
              latency_ms: number | null;
              queue_ms: number | null;
              error: string | null;
              score: number | null;
              reasoning: string | null;
              errors: string | null;
            }>(),
        );
        if (rows.results.length === 0) return yield* new HttpApiError.NotFound({});
        const parses = yield* query(() =>
          Promise.all(
            rows.results.map(async (row) => ({
              presetId: row.preset_id,
              status: row.status,
              latencyMs: row.latency_ms,
              queueMs: row.queue_ms,
              markdown: (await (await cf.BLOBS.get(markdownKey(params.runId, params.pageId, row.preset_id)))?.text()) ?? null,
              error: row.error,
              score: row.score,
              reasoning: row.reasoning,
              errors: row.errors === null ? [] : (JSON.parse(row.errors) as unknown),
            })),
          ),
        );
        return { pageId: params.pageId, parses };
      }),
    ),
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([PresetsLive, DocumentsLive, RunsLive]),
  Layer.provide(HttpServer.layerServices),
);

export const { handler } = HttpRouter.toWebHandler(ApiLive);
