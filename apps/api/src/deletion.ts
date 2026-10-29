import type { Env } from "./env.ts";
import { documentKey, pagePdfKey, pagePngKey, sourceKey } from "./keys.ts";

type Scope = "data" | "report";

const removeKeys = async (blobs: R2Bucket, keys: ReadonlyArray<string>) => {
  for (let i = 0; i < keys.length; i += 1000) await blobs.delete(keys.slice(i, i + 1000));
};

const removePrefix = async (blobs: R2Bucket, prefix: string) => {
  let cursor: string | undefined;
  do {
    const listed = await blobs.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    await removeKeys(
      blobs,
      listed.objects.map((o) => o.key),
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
};

const documentBlobs = async (env: Env, documentsSql: string, bind: string) => {
  const docs = await env.DB.prepare(`SELECT id, format FROM documents WHERE id IN (${documentsSql})`)
    .bind(bind)
    .all<{ id: string; format: string }>();
  const pages = await env.DB.prepare(`SELECT id FROM pages WHERE document_id IN (${documentsSql})`)
    .bind(bind)
    .all<{ id: string }>();
  return [
    ...docs.results.flatMap((d) => [sourceKey(d.id, d.format), documentKey(d.id)]),
    ...pages.results.flatMap((p) => [pagePdfKey(p.id), pagePngKey(p.id)]),
  ];
};

/**
 * Statements that remove documents (selected by `documentsSql`, one `?1` parameter) with their pages and every
 * parse, verdict and run link on those pages. Foreign keys are checked at commit, so the order is free.
 */
const documentStatements = (env: Env, documentsSql: string, bind: string) => {
  const pages = `SELECT id FROM pages WHERE document_id IN (${documentsSql})`;
  return [
    "PRAGMA defer_foreign_keys = on",
    `DELETE FROM verdicts WHERE page_id IN (${pages})`,
    `DELETE FROM parses WHERE page_id IN (${pages})`,
    `DELETE FROM judge_failures WHERE page_id IN (${pages})`,
    `DELETE FROM page_notes WHERE page_id IN (${pages})`,
    `DELETE FROM page_locations WHERE page_id IN (${pages})`,
    `DELETE FROM pages WHERE document_id IN (${documentsSql})`,
    `DELETE FROM run_documents WHERE document_id IN (${documentsSql})`,
    `DELETE FROM documents WHERE id IN (${documentsSql})`,
  ].map((sql) => (sql.startsWith("PRAGMA") ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(bind)));
};

/**
 * Deletes a run's documents, page images and parse outputs. With scope "report" the run row and its summary go too;
 * with "data" the summary stays and the run is marked `data_deleted_at`. R2 goes first so a failed call can be retried.
 */
export const deleteRun = async (env: Env, runId: string, scope: Scope) => {
  const docs = "SELECT document_id FROM run_documents WHERE run_id = ?1";
  await removeKeys(env.BLOBS, await documentBlobs(env, docs, runId));
  await removePrefix(env.BLOBS, `runs/${runId}/`);
  const run =
    scope === "report"
      ? [
          "DELETE FROM verdicts WHERE run_id = ?1",
          "DELETE FROM parses WHERE run_id = ?1",
          "DELETE FROM judge_failures WHERE run_id = ?1",
          "DELETE FROM page_notes WHERE run_id = ?1",
          "DELETE FROM page_locations WHERE run_id = ?1",
          "DELETE FROM run_credentials WHERE run_id = ?1",
          "DELETE FROM run_documents WHERE run_id = ?1",
          "DELETE FROM runs WHERE id = ?1",
        ]
      : ["UPDATE runs SET data_deleted_at = unixepoch() * 1000 WHERE id = ?1"];
  await env.DB.batch([...documentStatements(env, docs, runId), ...run.map((sql) => env.DB.prepare(sql).bind(runId))]);
};

/** Deletes every run, report and document a user owns, then the user. */
export const deleteUser = async (env: Env, userId: string) => {
  const runs = await env.DB.prepare("SELECT id FROM runs WHERE user_id = ?").bind(userId).all<{ id: string }>();
  for (const run of runs.results) await deleteRun(env, run.id, "report");
  const docs = "SELECT id FROM documents WHERE user_id = ?1";
  await removeKeys(env.BLOBS, await documentBlobs(env, docs, userId));
  await env.DB.batch([
    ...documentStatements(env, docs, userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM logins WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
};

/** Deletes uploads of sign-ins that never completed (still owned by the pending user) made before `before`. */
export const deleteExpiredUploads = async (env: Env, before: number) => {
  const docs = "SELECT id FROM documents WHERE user_id = 'pending' AND created_at < ?1";
  await removeKeys(env.BLOBS, await documentBlobs(env, docs, String(before)));
  await env.DB.batch(documentStatements(env, docs, String(before)));
};
