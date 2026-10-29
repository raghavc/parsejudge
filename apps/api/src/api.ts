import { env } from "cloudflare:workers";
import { DEFAULT_PRESET_IDS, ErrorCategory, findPreset, JUDGE_VERSION, PRESETS, sniffFormat, splitPages } from "@parsejudge/core";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup } from "effect/http-api";
import { PENDING_USER, pendingLogin, sessionUser } from "./auth.ts";
import { signedBlobUrl } from "./blobs.ts";
import { toPdf } from "./converter.ts";
import { encryptCredentials } from "./credentials.ts";
import { deleteRun, deleteUser } from "./deletion.ts";
import type { Env } from "./env.ts";
import { INTERNAL_HEADER, internalUser } from "./internal.ts";
import { documentKey, markdownKey, pageId as pageIdOf, pagePdfKey, pagePngKey, sourceKey } from "./keys.ts";
import { generateTitle } from "./title.ts";

const cf = env as unknown as Env;

const PresetInfo = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.String,
  mode: Schema.String,
  listPriceUsdPerPage: Schema.Number,
  hosted: Schema.Boolean,
  default: Schema.Boolean,
});

const CreateRun = Schema.Struct({
  documentIds: Schema.Array(Schema.String),
  presetIds: Schema.optional(Schema.Array(Schema.String)),
  title: Schema.optional(Schema.String),
  /** BYOK keys by provider id, e.g. `{ "llamaparse": { "LLAMA_CLOUD_API_KEY": "..." } }`. */
  credentials: Schema.optional(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
});

/** One row of the signed-in user's run list. */
const RunListItem = Schema.Struct({
  id: Schema.String,
  shareId: Schema.String,
  title: Schema.NullOr(Schema.String),
  status: Schema.String,
  presetIds: Schema.Array(Schema.String),
  documents: Schema.Number,
  pages: Schema.Number,
  /** Pages the judge has finished. */
  judged: Schema.Number,
  /** The preset with the highest mean score, once the run is summarized. */
  top: Schema.NullOr(Schema.Struct({ presetId: Schema.String, meanScore: Schema.Number })),
  createdAt: Schema.Number,
  dataDeletedAt: Schema.NullOr(Schema.Number),
  visibility: Schema.String,
});

const Visibility = Schema.Literals(["private", "link"]);

const Account = Schema.Struct({ email: Schema.String, notifyOnDone: Schema.Boolean });

const Interval = Schema.Struct({ low: Schema.Number, high: Schema.Number });

/** Mirrors `RunSummary` in @parsejudge/core. */
const RunSummary = Schema.Struct({
  presets: Schema.Array(
    Schema.Struct({
      presetId: Schema.String,
      label: Schema.String,
      pages: Schema.Number,
      failedPages: Schema.Number,
      meanScore: Schema.NullOr(Schema.Number),
      medianScore: Schema.NullOr(Schema.Number),
      highSeverityRate: Schema.NullOr(Schema.Number),
      highSeverityInterval: Schema.NullOr(Interval),
      errorCounts: Schema.Record(ErrorCategory, Schema.optional(Schema.Number)),
      listPriceUsdPerPage: Schema.Number,
      observedCostUsdPerPage: Schema.NullOr(Schema.Number),
      latencyMsMean: Schema.NullOr(Schema.Number),
      latencyMsP50: Schema.NullOr(Schema.Number),
      latencyMsP95: Schema.NullOr(Schema.Number),
    }),
  ),
  headToHead: Schema.Array(
    Schema.Struct({
      presetId: Schema.String,
      opponentId: Schema.String,
      wins: Schema.Number,
      ties: Schema.Number,
      losses: Schema.Number,
    }),
  ),
  tradeoff: Schema.Array(
    Schema.Struct({
      presetId: Schema.String,
      listPriceUsdPerPage: Schema.Number,
      meanScore: Schema.Number,
      pareto: Schema.Boolean,
    }),
  ),
});

/** `imageUrl` is the rendered page PNG every provider got. It expires after an hour and 404s until the page is rendered. */
const PageRef = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  imageUrl: Schema.String,
  /** One sentence on how the providers differ, for pages with a score gap or a failed parse. */
  note: Schema.NullOr(Schema.String),
});

const DocumentInfo = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  format: Schema.String,
  pages: Schema.Array(PageRef),
});

const Run = Schema.Struct({
  id: Schema.String,
  shareId: Schema.String,
  title: Schema.NullOr(Schema.String),
  status: Schema.String,
  presetIds: Schema.Array(Schema.String),
  judgeVersion: Schema.String,
  judgeModel: Schema.String,
  documents: Schema.Array(DocumentInfo),
  /** One entry per (page, preset) parse that has finished. */
  scores: Schema.Array(
    Schema.Struct({
      pageId: Schema.String,
      presetId: Schema.String,
      status: Schema.String,
      score: Schema.NullOr(Schema.Number),
      /** High-severity errors the judge found in this parse. */
      high: Schema.Number,
    }),
  ),
  summary: Schema.NullOr(RunSummary),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  /** Set when the owner deleted the documents; the summary stays. */
  dataDeletedAt: Schema.NullOr(Schema.Number),
  /** Who can open the share link: "link" (anyone with it) or "private" (only the owner). */
  visibility: Schema.String,
  /** Whether the signed-in caller owns this run. */
  owned: Schema.Boolean,
});

/** The judge's errors, each with the excerpts the locate step found for it. Errors that were not located have no quotes. */
const withQuotes = (errors: string | null, quotes: string | null): ReadonlyArray<unknown> => {
  const located = JSON.parse(quotes ?? "[]") as ReadonlyArray<unknown>;
  return (JSON.parse(errors ?? "[]") as ReadonlyArray<Record<string, unknown>>).map(({ quotes: _, ...error }, i) =>
    located[i] === undefined ? error : { ...error, quotes: located[i] },
  );
};

const PageDetail = Schema.Struct({
  pageId: Schema.String,
  imageUrl: Schema.String,
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
  .add(
    HttpApiGroup.make("account")
      .add(HttpApiEndpoint.get("get", "/v1/account", { success: Account, error: HttpApiError.Unauthorized }))
      .add(
        HttpApiEndpoint.patch("update", "/v1/account", {
          payload: Schema.Struct({ notifyOnDone: Schema.Boolean }),
          success: Account,
          error: HttpApiError.Unauthorized,
        }),
      )
      .add(HttpApiEndpoint.delete("remove", "/v1/account", { error: HttpApiError.Unauthorized })),
  )
  .add(HttpApiGroup.make("presets").add(HttpApiEndpoint.get("list", "/v1/presets", { success: Schema.Array(PresetInfo) })))
  .add(
    HttpApiGroup.make("documents")
      .add(
        HttpApiEndpoint.post("upload", "/v1/documents", {
          query: { filename: Schema.optional(Schema.String), upload: Schema.optional(Schema.String) },
          success: Schema.Struct({ documentId: Schema.String, pageCount: Schema.Number }),
          error: [HttpApiError.BadRequest, HttpApiError.Unauthorized, HttpApiError.ServiceUnavailable],
        }),
      )
      .add(
        HttpApiEndpoint.get("uploaded", "/v1/documents", {
          query: { upload: Schema.String },
          success: Schema.Array(
            Schema.Struct({
              documentId: Schema.String,
              filename: Schema.String,
              pageCount: Schema.Number,
              createdAt: Schema.Number,
            }),
          ),
          error: HttpApiError.Unauthorized,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("titles").add(
      HttpApiEndpoint.post("generate", "/v1/titles", {
        payload: Schema.Struct({ filenames: Schema.Array(Schema.String) }),
        success: Schema.Struct({ title: Schema.NullOr(Schema.String) }),
        error: [HttpApiError.BadRequest, HttpApiError.Unauthorized],
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
      .add(HttpApiEndpoint.get("mine", "/v1/runs", { success: Schema.Array(RunListItem), error: HttpApiError.Unauthorized }))
      .add(
        HttpApiEndpoint.patch("rename", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          payload: Schema.Struct({ title: Schema.optional(Schema.String), visibility: Schema.optional(Visibility) }),
          error: [HttpApiError.Unauthorized, HttpApiError.NotFound, HttpApiError.BadRequest],
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
        HttpApiEndpoint.delete("remove", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          query: { scope: Schema.Literals(["data", "report"]) },
          error: [HttpApiError.Unauthorized, HttpApiError.NotFound],
        }),
      )
      .add(
        HttpApiEndpoint.post("rotateLink", "/v1/runs/:runId/share-link", {
          params: { runId: Schema.String },
          success: Schema.Struct({ shareId: Schema.String }),
          error: [HttpApiError.Unauthorized, HttpApiError.NotFound],
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

/** The x-parsejudge-user header, trusted only in dev auth mode on localhost. */
const devHeaderEmail = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const host = (request.headers.host ?? "").replace(/:\d+$/, "");
  const email = request.headers["x-parsejudge-user"];
  if (cf.AUTH_MODE !== "dev" || (host !== "localhost" && host !== "127.0.0.1") || email === undefined) return null;
  return email.toLowerCase();
});

/** The signed-in user's id (session cookie; the x-parsejudge-user header too in dev auth mode), without creating a user. */
const signedInUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const internal = internalUser(request.headers[INTERNAL_HEADER]);
  if (internal !== null) {
    const user = yield* query(() => cf.DB.prepare("SELECT id FROM users WHERE id = ?").bind(internal).first<{ id: string }>());
    return user?.id ?? null;
  }
  const session = yield* query(() => sessionUser(cf, request.headers.cookie));
  if (session !== null) return session.id;
  const email = yield* devHeaderEmail;
  if (email === null) return null;
  const user = yield* query(() => cf.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>());
  return user?.id ?? null;
});

const requireUser = Effect.gen(function* () {
  const id = yield* signedInUser;
  if (id === null) return yield* new HttpApiError.Unauthorized({});
  return id;
});

/** Like requireUser; in dev auth mode it also creates the header's user. */
const currentUser = Effect.gen(function* () {
  const id = yield* signedInUser;
  if (id !== null) return id;
  const email = yield* devHeaderEmail;
  if (email === null || !email.includes("@")) return yield* new HttpApiError.Unauthorized({});
  const newId = crypto.randomUUID();
  yield* query(() =>
    cf.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
      .bind(newId, email, Date.now())
      .run(),
  );
  const user = yield* query(() => cf.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>());
  return user?.id ?? newId;
});

/** Who an upload belongs to: the signed-in user, or else this browser's open sign-in (its user once it completes). */
const uploader = Effect.gen(function* () {
  const user = yield* signedInUser;
  if (user !== null) return { userId: user, loginId: null };
  const request = yield* HttpServerRequest.HttpServerRequest;
  const loginId = yield* query(() => pendingLogin(cf, request.headers.cookie));
  if (loginId !== null) return { userId: PENDING_USER, loginId };
  return { userId: yield* currentUser, loginId: null };
});

const newShareId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** Whether the caller may read a run's pages: its owner, or anyone while the share link is open. */
export const canOpenRun = (runId: string) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      cf.DB.prepare("SELECT user_id, visibility FROM runs WHERE id = ?")
        .bind(runId)
        .first<{ user_id: string; visibility: string }>(),
    );
    if (row === null) return false;
    return row.visibility === "link" || (yield* signedInUser) === row.user_id;
  });

const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

type RunRow = {
  id: string;
  share_id: string;
  title: string | null;
  status: string;
  preset_ids: string;
  judge_version: string;
  judge_model: string;
  summary: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  user_id: string;
  data_deleted_at: number | null;
  visibility: string;
};

const toRun = (row: RunRow) => ({
  id: row.id,
  shareId: row.share_id,
  title: row.title,
  status: row.status,
  presetIds: JSON.parse(row.preset_ids) as Array<string>,
  judgeVersion: row.judge_version,
  judgeModel: row.judge_model,
  summary: row.summary === null ? null : (JSON.parse(row.summary) as typeof RunSummary.Type),
  error: row.error,
  createdAt: row.created_at,
  completedAt: row.completed_at,
  dataDeletedAt: row.data_deleted_at,
  visibility: row.visibility,
});

const pageImageUrl = (pageId: string) => signedBlobUrl(cf.PUBLIC_URL, cf.BLOB_SIGNING_KEY, pagePngKey(pageId));

const runDocuments = (runId: string) =>
  query(async () => {
    const rows = await cf.DB.prepare(
      `SELECT d.id, d.filename, d.format, d.page_count FROM run_documents r JOIN documents d ON d.id = r.document_id
       WHERE r.run_id = ? ORDER BY d.created_at, d.id`,
    )
      .bind(runId)
      .all<{ id: string; filename: string; format: string; page_count: number }>();
    const notes = await cf.DB.prepare("SELECT page_id, note FROM page_notes WHERE run_id = ?")
      .bind(runId)
      .all<{ page_id: string; note: string }>();
    const noteOf = new Map(notes.results.map((n) => [n.page_id, n.note]));
    return Promise.all(
      rows.results.map(async (row) => ({
        id: row.id,
        filename: row.filename,
        format: row.format,
        pages: await Promise.all(
          Array.from({ length: row.page_count }, async (_, index) => {
            const id = pageIdOf(row.id, index);
            return { id, index, imageUrl: await pageImageUrl(id), note: noteOf.get(id) ?? null };
          }),
        ),
      })),
    );
  });

const runScores = (runId: string) =>
  query(async () => {
    const rows = await cf.DB.prepare(
      `SELECT p.page_id, p.preset_id, p.status, v.score,
         (SELECT COUNT(*) FROM json_each(v.errors) e WHERE json_extract(e.value, '$.severity') = 'high') AS high
       FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ?`,
    )
      .bind(runId)
      .all<{ page_id: string; preset_id: string; status: string; score: number | null; high: number }>();
    return rows.results.map((row) => ({
      pageId: row.page_id,
      presetId: row.preset_id,
      status: row.status,
      score: row.score,
      high: row.high,
    }));
  });

const findRun = (column: "id" | "share_id", value: string) =>
  Effect.gen(function* () {
    const row = yield* query(() => cf.DB.prepare(`SELECT * FROM runs WHERE ${column} = ?`).bind(value).first<RunRow>());
    if (row === null) return yield* new HttpApiError.NotFound({});
    const owned = (yield* signedInUser) === row.user_id;
    if (!owned && (column === "id" || row.visibility !== "link")) return yield* new HttpApiError.NotFound({});
    return { ...toRun(row), owned, documents: yield* runDocuments(row.id), scores: yield* runScores(row.id) };
  });

const PresetsLive = HttpApiBuilder.group(Api, "presets", (handlers) =>
  handlers.handle("list", () =>
    Effect.succeed(
      PRESETS.map((preset) => ({
        id: preset.id,
        provider: preset.provider,
        label: preset.label,
        mode: preset.mode,
        listPriceUsdPerPage: preset.listPriceUsdPerPage,
        hosted: preset.hosted,
        default: DEFAULT_PRESET_IDS.includes(preset.id),
      })),
    ),
  ),
);

const DocumentsLive = HttpApiBuilder.group(Api, "documents", (handlers) =>
  handlers
    .handle("upload", ({ query: { filename, upload } }) =>
      Effect.gen(function* () {
        const { userId, loginId } = yield* uploader;
        if (loginId !== null) {
          // Cheap checks before conversion; the insert below re-checks the cap atomically.
          const limiter = cf.UPLOAD_LIMIT;
          const allowed = limiter === undefined || (yield* query(() => limiter.limit({ key: loginId }))).success;
          const held = yield* query(() =>
            cf.DB.prepare("SELECT COALESCE(SUM(page_count), 0) AS pages FROM documents WHERE login_id = ?")
              .bind(loginId)
              .first<{ pages: number }>(),
          );
          if (!allowed || (held?.pages ?? 0) >= Number(cf.MAX_PAGES_PER_RUN)) return yield* new HttpApiError.BadRequest({});
        }
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
        const max = Number(cf.MAX_PAGES_PER_RUN);
        yield* query(() => cf.BLOBS.put(sourceKey(documentId, format), bytes));
        yield* query(() => cf.BLOBS.put(documentKey(documentId), pdf));
        // Before sign-in completes, one check-and-insert caps the pages a login holds (one run) and the pages
        // waiting under all open logins from its client (two runs), so parallel uploads cannot pass the cap together.
        const inserted = yield* query(async () =>
          cf.DB.prepare(
            // A sign-in that completes while this upload runs has already set logins.user_id; the upload goes to that user.
            `INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at, upload_id)
           SELECT ?1, COALESCE((SELECT user_id FROM logins WHERE id = ?2), ?3), ?2, ?4, ?5, ?6, ?7, ?8, ?11
           WHERE ?2 IS NULL OR (
             (SELECT COALESCE(SUM(page_count), 0) FROM documents WHERE login_id = ?2) + ?7 <= ?9 AND
             (SELECT COALESCE(SUM(page_count), 0) FROM documents WHERE user_id = ?10 AND login_id IN
               (SELECT id FROM logins WHERE ip = (SELECT ip FROM logins WHERE id = ?2))) + ?7 <= ?9 * 2
           )`,
          )
            .bind(
              documentId,
              loginId,
              userId,
              filename ?? `document.${format}`,
              format,
              await sha256(bytes),
              pages.length,
              Date.now(),
              max,
              PENDING_USER,
              loginId === null ? (upload ?? null) : null,
            )
            .run(),
        );
        if (inserted.meta.changes !== 1) {
          yield* query(() => cf.BLOBS.delete([sourceKey(documentId, format), documentKey(documentId)]));
          return yield* new HttpApiError.BadRequest({});
        }
        yield* query(() => Promise.all(pages.map((page, index) => cf.BLOBS.put(pagePdfKey(pageIdOf(documentId, index)), page))));
        yield* query(() =>
          cf.DB.batch(
            pages.map((_, index) =>
              cf.DB.prepare("INSERT OR IGNORE INTO pages (id, document_id, page_index, rendered) VALUES (?, ?, ?, 0)").bind(
                pageIdOf(documentId, index),
                documentId,
                index,
              ),
            ),
          ),
        );
        yield* query(() => cf.DOCUMENT_WORKFLOW.create({ id: documentId, params: { documentId, pageCount: pages.length } }));
        return { documentId, pageCount: pages.length };
      }),
    )
    .handle("uploaded", ({ query: { upload } }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const rows = yield* query(() =>
          cf.DB.prepare(
            "SELECT id, filename, page_count, created_at FROM documents WHERE user_id = ? AND upload_id = ? ORDER BY created_at",
          )
            .bind(userId, upload)
            .all<{ id: string; filename: string; page_count: number; created_at: number }>(),
        );
        return rows.results.map((row) => ({
          documentId: row.id,
          filename: row.filename,
          pageCount: row.page_count,
          createdAt: row.created_at,
        }));
      }),
    ),
);

const TitlesLive = HttpApiBuilder.group(Api, "titles", (handlers) =>
  handlers.handle("generate", ({ payload }) =>
    Effect.gen(function* () {
      const { filenames } = payload;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = (yield* signedInUser) ?? (yield* query(() => pendingLogin(cf, request.headers.cookie)));
      if (key === null) return yield* new HttpApiError.Unauthorized({});
      const limiter = cf.TITLE_LIMIT;
      if (limiter !== undefined && !(yield* query(() => limiter.limit({ key }))).success) {
        return yield* new HttpApiError.BadRequest({});
      }
      if (filenames.length === 0 || filenames.length > 1000) return yield* new HttpApiError.BadRequest({});
      return {
        title: yield* query(() =>
          generateTitle(
            cf,
            filenames.map((name) => name.slice(0, 200)),
          ),
        ),
      };
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
             WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
          )
            .bind(userId, JSON.stringify(payload.documentIds))
            .first<{ pages: number; n: number }>(),
        );
        if (owned?.n !== payload.documentIds.length || owned.pages > Number(cf.MAX_PAGES_PER_RUN)) {
          return yield* new HttpApiError.BadRequest({});
        }
        const title =
          payload.title?.trim().slice(0, 80) ||
          (yield* query(async () => {
            const rows = await cf.DB.prepare(
              `SELECT filename FROM documents WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
            )
              .bind(userId, JSON.stringify(payload.documentIds))
              .all<{ filename: string }>();
            return generateTitle(
              cf,
              rows.results.map((row) => row.filename),
            );
          }));
        const runId = crypto.randomUUID();
        const shareId = newShareId();
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
              `INSERT INTO runs (id, user_id, share_id, title, status, preset_ids, judge_version, judge_model, created_at)
               VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
            ).bind(runId, userId, shareId, title, JSON.stringify(presetIds), JUDGE_VERSION, cf.JUDGE_MODEL, Date.now()),
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
    .handle("remove", ({ params, query: { scope } }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const row = yield* query(() =>
          cf.DB.prepare("SELECT user_id, status FROM runs WHERE id = ?")
            .bind(params.runId)
            .first<{ user_id: string; status: string }>(),
        );
        if (row === null || row.user_id !== userId) return yield* new HttpApiError.NotFound({});
        yield* query(() => deleteRun(cf, params.runId, scope));
      }),
    )
    .handle("mine", () =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const rows = yield* query(() =>
          cf.DB.prepare(
            `SELECT r.id, r.share_id, r.title, r.status, r.preset_ids, r.summary, r.created_at, r.data_deleted_at, r.visibility,
               (SELECT COUNT(*) FROM run_documents rd WHERE rd.run_id = r.id) AS documents,
               (SELECT COALESCE(SUM(d.page_count), 0) FROM run_documents rd JOIN documents d ON d.id = rd.document_id
                 WHERE rd.run_id = r.id) AS pages,
               (SELECT COUNT(DISTINCT page_id) FROM verdicts v WHERE v.run_id = r.id) AS judged
             FROM runs r WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 500`,
          )
            .bind(userId)
            .all<{
              id: string;
              share_id: string;
              title: string | null;
              status: string;
              preset_ids: string;
              summary: string | null;
              created_at: number;
              data_deleted_at: number | null;
              visibility: string;
              documents: number;
              pages: number;
              judged: number;
            }>(),
        );
        return rows.results.map((row) => {
          const summary = row.summary === null ? null : (JSON.parse(row.summary) as typeof RunSummary.Type);
          const top = (summary?.presets ?? []).reduce<{ presetId: string; meanScore: number } | null>(
            (best, preset) =>
              preset.meanScore !== null && (best === null || preset.meanScore > best.meanScore)
                ? { presetId: preset.presetId, meanScore: preset.meanScore }
                : best,
            null,
          );
          const presetIds = JSON.parse(row.preset_ids) as Array<string>;
          return {
            id: row.id,
            shareId: row.share_id,
            title: row.title,
            status: row.status,
            presetIds,
            documents: row.documents,
            pages: row.pages,
            judged: row.judged,
            top,
            createdAt: row.created_at,
            dataDeletedAt: row.data_deleted_at,
            visibility: row.visibility,
          };
        });
      }),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const title = payload.title?.trim().slice(0, 80) ?? null;
        if (title === "" || (title === null && payload.visibility === undefined)) return yield* new HttpApiError.BadRequest({});
        const updated = yield* query(() =>
          cf.DB.prepare(
            "UPDATE runs SET title = COALESCE(?, title), visibility = COALESCE(?, visibility) WHERE id = ? AND user_id = ?",
          )
            .bind(title, payload.visibility ?? null, params.runId, userId)
            .run(),
        );
        if (updated.meta.changes !== 1) return yield* new HttpApiError.NotFound({});
      }),
    )
    .handle("rotateLink", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const shareId = newShareId();
        const updated = yield* query(() =>
          cf.DB.prepare("UPDATE runs SET share_id = ? WHERE id = ? AND user_id = ?").bind(shareId, params.runId, userId).run(),
        );
        if (updated.meta.changes !== 1) return yield* new HttpApiError.NotFound({});
        return { shareId };
      }),
    )
    .handle("get", ({ params }) => findRun("id", params.runId))
    .handle("shared", ({ params }) => findRun("share_id", params.shareId))
    .handle("page", ({ params }) =>
      Effect.gen(function* () {
        if (!(yield* canOpenRun(params.runId))) return yield* new HttpApiError.NotFound({});
        const rows = yield* query(() =>
          cf.DB.prepare(
            `SELECT p.preset_id, p.status, p.latency_ms, p.queue_ms, p.error, v.score, v.reasoning, v.errors, l.quotes
             FROM parses p LEFT JOIN verdicts v USING (run_id, page_id, preset_id)
             LEFT JOIN page_locations l USING (run_id, page_id, preset_id) WHERE p.run_id = ? AND p.page_id = ?`,
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
              quotes: string | null;
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
              errors: withQuotes(row.errors, row.quotes),
            })),
          ),
        );
        return { pageId: params.pageId, imageUrl: yield* query(() => pageImageUrl(params.pageId)), parses };
      }),
    ),
);

const account = Effect.gen(function* () {
  const userId = yield* requireUser;
  const row = yield* query(() =>
    cf.DB.prepare("SELECT email, notify_on_done FROM users WHERE id = ?")
      .bind(userId)
      .first<{ email: string; notify_on_done: number }>(),
  );
  if (row === null) return yield* new HttpApiError.Unauthorized({});
  return { email: row.email, notifyOnDone: row.notify_on_done === 1 };
});

const AccountLive = HttpApiBuilder.group(Api, "account", (handlers) =>
  handlers
    .handle("get", () => account)
    .handle("update", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        yield* query(() =>
          cf.DB.prepare("UPDATE users SET notify_on_done = ? WHERE id = ?")
            .bind(payload.notifyOnDone ? 1 : 0, userId)
            .run(),
        );
        return yield* account;
      }),
    )
    .handle("remove", () =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        yield* query(() => deleteUser(cf, userId));
      }),
    ),
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([AccountLive, PresetsLive, DocumentsLive, TitlesLive, RunsLive]),
  Layer.provide(HttpServer.layerServices),
);

export const { handler } = HttpRouter.toWebHandler(ApiLive);
