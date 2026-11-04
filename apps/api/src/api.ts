import { env } from "cloudflare:workers";
import { DEFAULT_PRESET_IDS, ErrorCategory, findPreset, JUDGE_VERSION, PRESETS, sniffFormat, splitPages } from "@parsejudge/core";
import { Cause, Data, Effect, Layer, Schedule, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiMiddleware } from "effect/http-api";
import { PENDING_USER, pendingLogin, sessionUser } from "./auth.ts";
import { signedBlobUrl } from "./blobs.ts";
import { toPdf } from "./converter.ts";
import { encryptCredentials } from "./credentials.ts";
import { deleteRun, deleteUser } from "./deletion.ts";
import type { Env } from "./env.ts";
import { INTERNAL_HEADER, internalUser } from "./internal.ts";
import { documentKey, markdownKey, pageId as pageIdOf, pagePdfKey, pagePngKey, sourceKey } from "./keys.ts";
import { continueRun } from "./run.ts";
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
  /** Retrying with the same key returns the run the first request created. */
  idempotencyKey: Schema.optional(Schema.String),
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
  shareContent: Schema.Boolean,
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
  /** Whether link viewers get the documents, page images and parser output, or only the summary. */
  shareContent: Schema.Boolean,
  documentCount: Schema.Number,
  pageCount: Schema.Number,
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

/** Every judged parse of a run that has at least one error, with its page and document. */
const RunErrors = Schema.Array(
  Schema.Struct({
    pageId: Schema.String,
    document: Schema.String,
    page: Schema.Number,
    presetId: Schema.String,
    score: Schema.Number,
    reasoning: Schema.String,
    errors: Schema.Unknown,
  }),
);

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

/** Every error response is JSON `{ _tag, error }`; the class sets the status. */
class BadRequest extends Schema.TaggedError<BadRequest>()("BadRequest", { error: Schema.String }, { httpApiStatus: 400 }) {}
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { error: Schema.String }, { httpApiStatus: 401 }) {}
class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { error: Schema.String }, { httpApiStatus: 404 }) {}
class TooManyRequests extends Schema.TaggedError<TooManyRequests>()(
  "TooManyRequests",
  { error: Schema.String },
  { httpApiStatus: 429 },
) {}
/** A D1, R2, Workflows or converter call failed. The request can be retried. */
class ServiceUnavailable extends Schema.TaggedError<ServiceUnavailable>()(
  "ServiceUnavailable",
  { error: Schema.String },
  { httpApiStatus: 503 },
) {}

const unauthorized = new Unauthorized({ error: "Sign in first." });
const notFound = new NotFound({ error: "Not found, or you can't open it." });

/** Adds ServiceUnavailable to every endpoint's errors, so any handler can fail with it. It passes requests through. */
class Dependencies extends HttpApiMiddleware.Service<Dependencies>()("Dependencies", { error: ServiceUnavailable }) {}

export const Api = HttpApi.make("parsejudge")
  .add(
    HttpApiGroup.make("account")
      .add(HttpApiEndpoint.get("get", "/v1/account", { success: Account, error: Unauthorized }))
      .add(
        HttpApiEndpoint.patch("update", "/v1/account", {
          payload: Schema.Struct({ notifyOnDone: Schema.Boolean }),
          success: Account,
          error: Unauthorized,
        }),
      )
      .add(HttpApiEndpoint.delete("remove", "/v1/account", { error: Unauthorized })),
  )
  .add(HttpApiGroup.make("presets").add(HttpApiEndpoint.get("list", "/v1/presets", { success: Schema.Array(PresetInfo) })))
  .add(
    HttpApiGroup.make("documents")
      .add(
        HttpApiEndpoint.post("upload", "/v1/documents", {
          query: { filename: Schema.optional(Schema.String), upload: Schema.optional(Schema.String) },
          success: Schema.Struct({ documentId: Schema.String, pageCount: Schema.Number }),
          error: [BadRequest, Unauthorized, TooManyRequests, ServiceUnavailable],
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
          error: Unauthorized,
        }),
      ),
  )
  .add(
    HttpApiGroup.make("titles").add(
      HttpApiEndpoint.post("generate", "/v1/titles", {
        payload: Schema.Struct({ filenames: Schema.Array(Schema.String) }),
        success: Schema.Struct({ title: Schema.NullOr(Schema.String) }),
        error: [BadRequest, Unauthorized, TooManyRequests],
      }),
    ),
  )
  .add(
    HttpApiGroup.make("runs")
      .add(
        HttpApiEndpoint.post("create", "/v1/runs", {
          payload: CreateRun,
          success: Schema.Struct({ runId: Schema.String, shareId: Schema.String }),
          error: [BadRequest, Unauthorized],
        }),
      )
      .add(HttpApiEndpoint.get("mine", "/v1/runs", { success: Schema.Array(RunListItem), error: Unauthorized }))
      .add(
        HttpApiEndpoint.patch("rename", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          payload: Schema.Struct({
            title: Schema.optional(Schema.String),
            visibility: Schema.optional(Visibility),
            shareContent: Schema.optional(Schema.Boolean),
          }),
          error: [Unauthorized, NotFound, BadRequest],
        }),
      )
      .add(
        HttpApiEndpoint.get("get", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          success: Run,
          error: NotFound,
        }),
      )
      .add(
        HttpApiEndpoint.get("shared", "/v1/share/:shareId", {
          params: { shareId: Schema.String },
          success: Run,
          error: NotFound,
        }),
      )
      .add(
        HttpApiEndpoint.delete("remove", "/v1/runs/:runId", {
          params: { runId: Schema.String },
          query: { scope: Schema.Literals(["data", "report"]) },
          error: [Unauthorized, NotFound],
        }),
      )
      .add(
        HttpApiEndpoint.post("rotateLink", "/v1/runs/:runId/share-link", {
          params: { runId: Schema.String },
          success: Schema.Struct({ shareId: Schema.String }),
          error: [Unauthorized, NotFound],
        }),
      )
      .add(
        HttpApiEndpoint.post("continue", "/v1/runs/:runId/continue", {
          params: { runId: Schema.String },
          success: Schema.Struct({ skipped: Schema.Number }),
          error: [HttpApiError.Unauthorized, HttpApiError.NotFound, HttpApiError.Conflict],
        }),
      )
      .add(
        HttpApiEndpoint.get("errors", "/v1/runs/:runId/errors", {
          params: { runId: Schema.String },
          success: RunErrors,
          error: NotFound,
        }),
        HttpApiEndpoint.get("page", "/v1/runs/:runId/pages/:pageId", {
          params: { runId: Schema.String, pageId: Schema.String },
          success: PageDetail,
          error: NotFound,
        }),
      ),
  )
  .middleware(Dependencies);

/** A D1, R2, Workflows or rate-limiter call. A rejection is logged and becomes ServiceUnavailable. */
const query = <A>(promise: () => Promise<A>) =>
  Effect.tryPromise({
    try: promise,
    catch: (cause) => {
      console.error("Storage call failed", cause);
      return new ServiceUnavailable({ error: "A storage call failed. Retry the request." });
    },
  });

class WorkflowNotStarted extends Data.TaggedError("WorkflowNotStarted")<{ readonly id: string; readonly cause: unknown }> {}

/**
 * Creates a workflow instance, with retries. A failed create whose instance exists anyway (a lost response, or an
 * earlier attempt) counts as created.
 */
const createWorkflow = <P>(binding: Workflow<P>, id: string, params: P) =>
  Effect.tryPromise({
    try: () => binding.create({ id, params }).catch((error: unknown) => binding.get(id).catch(() => Promise.reject(error))),
    catch: (cause) => new WorkflowNotStarted({ id, cause }),
  }).pipe(Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 3 }));

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
  if (id === null) return yield* unauthorized;
  return id;
});

/** Like requireUser; in dev auth mode it also creates the header's user. */
const currentUser = Effect.gen(function* () {
  const id = yield* signedInUser;
  if (id !== null) return id;
  const email = yield* devHeaderEmail;
  if (email === null || !email.includes("@")) return yield* unauthorized;
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

/** Whether the caller may read a run's pages: its owner, or anyone while the share link is open and shares content. */
export const canOpenRun = (runId: string) =>
  Effect.gen(function* () {
    const row = yield* query(() =>
      cf.DB.prepare("SELECT user_id, visibility, share_content FROM runs WHERE id = ?")
        .bind(runId)
        .first<{ user_id: string; visibility: string; share_content: number }>(),
    );
    if (row === null) return false;
    return (row.visibility === "link" && row.share_content === 1) || (yield* signedInUser) === row.user_id;
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
  share_content: number;
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
  shareContent: row.share_content === 1,
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
    if (row === null) return yield* notFound;
    const owned = (yield* signedInUser) === row.user_id;
    if (!owned && (column === "id" || row.visibility !== "link")) return yield* notFound;
    const documents = yield* runDocuments(row.id);
    const counts = {
      documentCount: documents.length,
      pageCount: documents.reduce((n, d) => n + d.pages.length, 0),
    };
    if (!owned && row.share_content !== 1) return { ...toRun(row), ...counts, owned, documents: [], scores: [] };
    return { ...toRun(row), ...counts, owned, documents, scores: yield* runScores(row.id) };
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

const overCap = new BadRequest({
  error: "Uploads before sign-in are limited to one run's pages. Sign in to upload more.",
});

const DocumentsLive = HttpApiBuilder.group(Api, "documents", (handlers) =>
  handlers
    .handle("upload", ({ query: { filename, upload } }) =>
      Effect.gen(function* () {
        const { userId, loginId } = yield* uploader;
        if (loginId !== null) {
          // Cheap checks before conversion; the insert below re-checks the cap atomically.
          const limiter = cf.UPLOAD_LIMIT;
          const allowed = limiter === undefined || (yield* query(() => limiter.limit({ key: loginId }))).success;
          if (!allowed) return yield* new TooManyRequests({ error: "Too many uploads. Wait a minute and retry." });
          const held = yield* query(() =>
            cf.DB.prepare("SELECT COALESCE(SUM(page_count), 0) AS pages FROM documents WHERE login_id = ?")
              .bind(loginId)
              .first<{ pages: number }>(),
          );
          if ((held?.pages ?? 0) >= Number(cf.MAX_PAGES_PER_RUN)) return yield* overCap;
        }
        const request = yield* HttpServerRequest.HttpServerRequest;
        const bytes = new Uint8Array(
          yield* request.arrayBuffer.pipe(Effect.mapError(() => new BadRequest({ error: "Could not read the request body." }))),
        );
        const format = yield* sniffFormat(bytes);
        const pdf = yield* toPdf(cf, format, bytes).pipe(
          Effect.catchTag("ConverterUnavailable", (error) => {
            console.error("Document conversion failed", error.message);
            return Effect.fail(new ServiceUnavailable({ error: "Document conversion is unavailable. Retry in a minute." }));
          }),
        );
        const pages = yield* splitPages(pdf, Number(cf.MAX_PAGES_PER_RUN));
        const documentId = crypto.randomUUID();
        const max = Number(cf.MAX_PAGES_PER_RUN);
        const blobKeys = [
          sourceKey(documentId, format),
          documentKey(documentId),
          ...pages.map((_, index) => pagePdfKey(pageIdOf(documentId, index))),
        ];
        yield* Effect.gen(function* () {
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
          if (inserted.meta.changes !== 1) return yield* overCap;
          yield* query(() =>
            Promise.all(pages.map((page, index) => cf.BLOBS.put(pagePdfKey(pageIdOf(documentId, index)), page))),
          );
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
        }).pipe(
          // Remove whatever was written, so a failed upload leaves no blobs or rows behind.
          Effect.onError(() =>
            Effect.all([
              query(() => cf.BLOBS.delete(blobKeys)),
              query(() =>
                cf.DB.batch([
                  cf.DB.prepare("DELETE FROM pages WHERE document_id = ?").bind(documentId),
                  cf.DB.prepare("DELETE FROM documents WHERE id = ?").bind(documentId),
                ]),
              ),
            ]).pipe(Effect.catch(() => Effect.sync(() => console.error("Upload cleanup failed", documentId)))),
          ),
        );
        yield* createWorkflow(cf.DOCUMENT_WORKFLOW, documentId, { documentId, pageCount: pages.length }).pipe(
          // It only renders page images ahead of a run; each PageWorkflow renders its own page if this never ran.
          Effect.catchTag("WorkflowNotStarted", (error) =>
            Effect.sync(() => console.error("Document workflow not started", documentId, error.cause)),
          ),
        );
        return { documentId, pageCount: pages.length };
      }).pipe(Effect.catchTag("InvalidDocument", (error) => Effect.fail(new BadRequest({ error: error.message })))),
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
      if (key === null) return yield* unauthorized;
      const limiter = cf.TITLE_LIMIT;
      if (limiter !== undefined && !(yield* query(() => limiter.limit({ key }))).success) {
        return yield* new TooManyRequests({ error: "Too many title requests. Wait a minute and retry." });
      }
      if (filenames.length === 0 || filenames.length > 1000) {
        return yield* new BadRequest({ error: "Send between 1 and 1,000 filenames." });
      }
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
        const presetIds = [...new Set(payload.presetIds ?? DEFAULT_PRESET_IDS)];
        const documentIds = [...new Set(payload.documentIds)];
        if (documentIds.length === 0 || presetIds.length === 0) {
          return yield* new BadRequest({ error: "Pick at least one document and one preset." });
        }
        for (const id of presetIds) {
          const preset = findPreset(id);
          if (preset === undefined) return yield* new BadRequest({ error: `Unknown preset ${id}.` });
          if (!preset.hosted && payload.credentials?.[preset.provider] === undefined)
            return yield* new BadRequest({ error: `Preset ${id} needs your ${preset.provider} key in credentials.` });
        }
        const owned = yield* query(() =>
          cf.DB.prepare(
            `SELECT COALESCE(SUM(page_count), 0) AS pages, COUNT(*) AS n FROM documents
             WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
          )
            .bind(userId, JSON.stringify(documentIds))
            .first<{ pages: number; n: number }>(),
        );
        if (owned?.n !== documentIds.length) {
          return yield* new BadRequest({ error: "Some documents are not yours, or were deleted." });
        }
        if (owned.pages > Number(cf.MAX_PAGES_PER_RUN)) {
          return yield* new BadRequest({ error: `A run can have at most ${cf.MAX_PAGES_PER_RUN} pages.` });
        }
        const key = payload.idempotencyKey?.trim().slice(0, 200) || null;
        const existing = () =>
          key === null
            ? Promise.resolve(null)
            : cf.DB.prepare("SELECT id AS runId, share_id AS shareId FROM runs WHERE user_id = ? AND idempotency_key = ?")
                .bind(userId, key)
                .first<{ runId: string; shareId: string }>();
        const earlier = yield* query(existing);
        if (earlier !== null) return earlier;
        const title =
          payload.title?.trim().slice(0, 80) ||
          (yield* query(async () => {
            const rows = await cf.DB.prepare(
              `SELECT filename FROM documents WHERE user_id = ? AND id IN (SELECT value FROM json_each(?))`,
            )
              .bind(userId, JSON.stringify(documentIds))
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
        const inserted = yield* query(async () => {
          try {
            await cf.DB.batch([
              cf.DB.prepare(
                `INSERT INTO runs (id, user_id, share_id, title, status, preset_ids, judge_version, judge_model, created_at, idempotency_key)
               VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
              ).bind(runId, userId, shareId, title, JSON.stringify(presetIds), JUDGE_VERSION, cf.JUDGE_MODEL, Date.now(), key),
              ...documentIds.map((documentId) =>
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
            ]);
            return null;
          } catch (error) {
            const raced = await existing();
            if (raced === null) throw error;
            return raced;
          }
        });
        if (inserted !== null) return inserted;
        yield* createWorkflow(cf.RUN_WORKFLOW, runId, { runId }).pipe(
          Effect.catchTag("WorkflowNotStarted", (error) =>
            Effect.gen(function* () {
              console.error("Run workflow not started", runId, error.cause);
              // Fail the run now so it is never stuck in queued, drop its keys, and free the idempotency key so a
              // retry creates a new run.
              yield* query(() =>
                cf.DB.batch([
                  cf.DB.prepare(
                    `UPDATE runs SET status = 'failed', error = 'The run could not be started.', completed_at = ?,
                       idempotency_key = NULL WHERE id = ? AND status = 'queued'`,
                  ).bind(Date.now(), runId),
                  cf.DB.prepare("DELETE FROM run_credentials WHERE run_id = ?").bind(runId),
                ]),
              );
              return yield* new ServiceUnavailable({ error: "The run could not be started. Retry the request." });
            }),
          ),
        );
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
        if (row === null || row.user_id !== userId) return yield* notFound;
        yield* query(() => deleteRun(cf, params.runId, scope));
      }),
    )
    .handle("mine", () =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const rows = yield* query(() =>
          cf.DB.prepare(
            `SELECT r.id, r.share_id, r.title, r.status, r.preset_ids, r.summary, r.created_at, r.data_deleted_at, r.visibility, r.share_content,
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
              share_content: number;
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
            shareContent: row.share_content === 1,
          };
        });
      }),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const title = payload.title?.trim().slice(0, 80) ?? null;
        const shareContent = payload.shareContent === undefined ? null : payload.shareContent ? 1 : 0;
        if (title === "" || (title === null && payload.visibility === undefined && shareContent === null))
          return yield* new BadRequest({ error: "Send a non-empty title, visibility or shareContent." });
        const updated = yield* query(() =>
          cf.DB.prepare(
            `UPDATE runs SET title = COALESCE(?, title), visibility = COALESCE(?, visibility),
               share_content = COALESCE(?, share_content) WHERE id = ? AND user_id = ?`,
          )
            .bind(title, payload.visibility ?? null, shareContent, params.runId, userId)
            .run(),
        );
        if (updated.meta.changes !== 1) return yield* notFound;
      }),
    )
    .handle("rotateLink", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const shareId = newShareId();
        const updated = yield* query(() =>
          cf.DB.prepare("UPDATE runs SET share_id = ? WHERE id = ? AND user_id = ?").bind(shareId, params.runId, userId).run(),
        );
        if (updated.meta.changes !== 1) return yield* notFound;
        return { shareId };
      }),
    )
    .handle("continue", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* requireUser;
        const row = yield* query(() =>
          cf.DB.prepare("SELECT user_id FROM runs WHERE id = ?").bind(params.runId).first<{ user_id: string }>(),
        );
        if (row === null || row.user_id !== userId) return yield* new HttpApiError.NotFound({});
        return yield* continueRun(cf, params.runId).pipe(
          Effect.catchTag("RunNotStarted", () => Effect.fail(new HttpApiError.Conflict({}))),
          Effect.orDie,
        );
      }),
    )
    .handle("get", ({ params }) => findRun("id", params.runId))
    .handle("shared", ({ params }) => findRun("share_id", params.shareId))
    .handle("errors", ({ params }) =>
      Effect.gen(function* () {
        if (!(yield* canOpenRun(params.runId))) return yield* notFound;
        const rows = yield* query(() =>
          cf.DB.prepare(
            `SELECT v.page_id, d.filename, pg.page_index, v.preset_id, v.score, v.reasoning, v.errors, l.quotes
             FROM verdicts v JOIN pages pg ON pg.id = v.page_id JOIN documents d ON d.id = pg.document_id
             LEFT JOIN page_locations l USING (run_id, page_id, preset_id)
             WHERE v.run_id = ? AND v.errors != '[]' ORDER BY d.filename, pg.page_index, v.preset_id`,
          )
            .bind(params.runId)
            .all<{
              page_id: string;
              filename: string;
              page_index: number;
              preset_id: string;
              score: number;
              reasoning: string;
              errors: string;
              quotes: string | null;
            }>(),
        );
        return rows.results.map((row) => ({
          pageId: row.page_id,
          document: row.filename,
          page: row.page_index + 1,
          presetId: row.preset_id,
          score: row.score,
          reasoning: row.reasoning,
          errors: withQuotes(row.errors, row.quotes),
        }));
      }),
    )
    .handle("page", ({ params }) =>
      Effect.gen(function* () {
        if (!(yield* canOpenRun(params.runId))) return yield* notFound;
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
        if (rows.results.length === 0) return yield* notFound;
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
  if (row === null) return yield* unauthorized;
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

const DependenciesLive = Layer.succeed(Dependencies, (httpEffect) => httpEffect);

/** Request decoding failures become JSON 400s. Any other defect is logged and becomes a JSON 500. */
const DefectsAsJson = HttpRouter.middleware(
  (httpEffect) =>
    Effect.catchCause(httpEffect, (cause) => {
      if (!Cause.hasDies(cause)) return Effect.failCause(cause);
      const defect = Cause.squash(cause);
      if (HttpApiError.HttpApiSchemaError.is(defect) && defect.kind !== "Body" && defect.kind !== "ResponseHeaders") {
        const error = `Invalid request ${defect.kind.toLowerCase()}: ${defect.cause.message}`;
        return Effect.succeed(HttpServerResponse.jsonUnsafe({ _tag: "BadRequest", error }, { status: 400 }));
      }
      console.error("Unhandled API error", Cause.pretty(cause));
      return Effect.succeed(
        HttpServerResponse.jsonUnsafe({ _tag: "InternalServerError", error: "Internal error." }, { status: 500 }),
      );
    }),
  { global: true },
);

const ApiLive = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([AccountLive, PresetsLive, DocumentsLive, TitlesLive, RunsLive]),
  Layer.provide(DependenciesLive),
  Layer.provide(HttpServer.layerServices),
);

export const { handler } = HttpRouter.toWebHandler(Layer.mergeAll(ApiLive, DefectsAsJson));
