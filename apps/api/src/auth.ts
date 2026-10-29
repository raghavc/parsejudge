import { deleteExpiredUploads } from "./deletion.ts";
import type { Env } from "./env.ts";

const LOGIN_TTL_MS = 15 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const MAX_ATTEMPTS = 5;
const PER_EMAIL_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;
const LOGIN_COOKIE = "pj_login";
const SESSION_COOKIE = "pj_session";
/** Owner of uploads made before sign-in completes. */
export const PENDING_USER = "pending";

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const randomCode = () => {
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    if (n < 4_294_000_000) return String(n % 1_000_000).padStart(6, "0");
  }
};
const hmac = async (env: Env, message: string) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.AUTH_KEY), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
};
const sameHash = (a: string, b: string) =>
  a.length === b.length && crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));

const cookieValue = (header: string | null | undefined, name: string) => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
};
const setCookie = (name: string, value: string, maxAgeMs: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;

const reply = (body: unknown, status = 200, cookies: ReadonlyArray<string> = []) => {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
};
const fail = (status: number, error: string) => reply({ error }, status);

/** The user of a valid session cookie. */
export const sessionUser = async (env: Env, cookies: string | null | undefined) => {
  const token = cookieValue(cookies, SESSION_COOKIE);
  if (token === undefined || token === "") return null;
  return env.DB.prepare(
    `SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.id_hash = ? AND sessions.expires_at > ?`,
  )
    .bind(await hmac(env, `session:${token}`), Date.now())
    .first<{ id: string; email: string }>();
};

/** The open sign-in this browser started (its `pj_login` cookie), if any. */
export const pendingLogin = async (env: Env, cookies: string | null | undefined): Promise<string | null> => {
  const [id, secret] = (cookieValue(cookies, LOGIN_COOKIE) ?? "").split(".");
  if (!id || !secret) return null;
  const row = await env.DB.prepare("SELECT secret_hash FROM logins WHERE id = ? AND used_at IS NULL AND expires_at > ?")
    .bind(id, Date.now())
    .first<{ secret_hash: string }>();
  return row !== null && sameHash(row.secret_hash, await hmac(env, `secret:${id}:${secret}`)) ? id : null;
};

const readBody = async (request: Request) => {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return body ?? {};
};

const emailText = (code: string, link: string) =>
  `Your ParseJudge sign-in code is ${code}.\n\nOr sign in with this link:\n${link}\n\nThe code and link work once and expire in 15 minutes. If you did not ask to sign in, ignore this email.`;
const emailHtml = (code: string, link: string) => `<div style="font-family:Inter,Arial,sans-serif;color:#0a0a0a;max-width:440px">
<p style="font-size:15px">Your ParseJudge sign-in code:</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:600;margin:8px 0 24px">${code}</p>
<p><a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none">Sign in to ParseJudge</a></p>
<p style="font-size:13px;color:#6b6b6b">The code and link work once and expire in 15 minutes. If you did not ask to sign in, ignore this email.</p>
</div>`;

/** POST /v1/auth/start: emails a code and a link, and sets `pj_login` so this browser can upload before sign-in completes. */
const start = async (env: Env, request: Request) => {
  const body = await readBody(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(400, "Enter a valid email address.");
  const presetIds = Array.isArray(body.presetIds)
    ? body.presetIds.filter((id): id is string => typeof id === "string" && id.length <= 100).slice(0, 50)
    : [];
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  const now = Date.now();
  const recent = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM logins WHERE email = ?1 AND created_at > ?3) AS email,
            (SELECT COUNT(*) FROM logins WHERE ip = ?2 AND created_at > ?3) AS ip`,
  )
    .bind(email, ip, now - 3_600_000)
    .first<{ email: number; ip: number }>();
  if ((recent?.email ?? 0) >= PER_EMAIL_PER_HOUR || (recent?.ip ?? 0) >= PER_IP_PER_HOUR) {
    return fail(429, "Too many sign-in emails. Try again in an hour.");
  }
  const id = crypto.randomUUID();
  const secret = randomToken();
  const link = randomToken();
  const code = randomCode();
  await env.DB.prepare(
    `INSERT INTO logins (id, email, secret_hash, code_hash, link_hash, preset_ids, ip, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      email,
      await hmac(env, `secret:${id}:${secret}`),
      await hmac(env, `code:${id}:${code}`),
      await hmac(env, `link:${id}:${link}`),
      JSON.stringify(presetIds),
      ip,
      now,
      now + LOGIN_TTL_MS,
    )
    .run();
  const url = `${env.PUBLIC_URL}/auth?token=${id}.${link}`;
  try {
    await env.EMAIL.send({
      from: { name: "ParseJudge", email: env.EMAIL_FROM },
      to: email,
      subject: `${code} is your ParseJudge sign-in code`,
      text: emailText(code, url),
      html: emailHtml(code, url),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "auth_email_failed", error: String(error) }));
    return fail(502, "We could not send the email. Try again.");
  }
  return reply({ ok: true }, 200, [setCookie(LOGIN_COOKIE, `${id}.${secret}`, LOGIN_TTL_MS)]);
};

/**
 * POST /v1/auth/verify with `{ code }` (needs this browser's `pj_login`) or `{ token }` (the emailed link, any browser).
 * Each try counts against the login; it works once. On success the login's uploads move to the user.
 */
const verify = async (env: Env, request: Request) => {
  const body = await readBody(request);
  let id: string | null;
  let kind: "code" | "link";
  let value: string;
  if (typeof body.token === "string") {
    kind = "link";
    const dot = body.token.indexOf(".");
    id = dot > 0 ? body.token.slice(0, dot) : null;
    value = body.token.slice(dot + 1);
  } else if (typeof body.code === "string") {
    kind = "code";
    id = await pendingLogin(env, request.headers.get("cookie"));
    value = body.code.replace(/\s/g, "");
  } else {
    return fail(400, "Missing code.");
  }
  const expired = "This sign-in has expired. Request a new email.";
  if (id === null) return fail(400, expired);
  const now = Date.now();
  const login = await env.DB.prepare(
    `UPDATE logins SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?
     RETURNING email, code_hash, link_hash, preset_ids, attempts`,
  )
    .bind(id, now, MAX_ATTEMPTS)
    .first<{ email: string; code_hash: string; link_hash: string; preset_ids: string; attempts: number }>();
  if (login === null) return fail(400, expired);
  if (!sameHash(kind === "code" ? login.code_hash : login.link_hash, await hmac(env, `${kind}:${id}:${value}`))) {
    const left = MAX_ATTEMPTS - login.attempts;
    if (kind === "link" || left === 0) return fail(400, expired);
    return fail(400, `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.`);
  }
  await env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(crypto.randomUUID(), login.email, now)
    .run();
  const user = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(login.email).first<{ id: string }>();
  if (user === null) return fail(500, "Sign-in failed. Try again.");
  const claimed = await env.DB.prepare("UPDATE logins SET used_at = ?, user_id = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, user.id, id)
    .run();
  if (claimed.meta.changes !== 1) return fail(400, expired);
  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE documents SET user_id = ? WHERE login_id = ? AND user_id = ?").bind(user.id, id, PENDING_USER),
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(
      await hmac(env, `session:${session}`),
      user.id,
      now,
      now + SESSION_TTL_MS,
    ),
  ]);
  const documents = await env.DB.prepare(
    `SELECT id AS documentId, filename, format, page_count AS pageCount FROM documents
     WHERE login_id = ? AND user_id = ? ORDER BY created_at`,
  )
    .bind(id, user.id)
    .all();
  return reply(
    { email: login.email, draft: { presetIds: JSON.parse(login.preset_ids) as Array<string>, documents: documents.results } },
    200,
    [setCookie(SESSION_COOKIE, session, SESSION_TTL_MS), setCookie(LOGIN_COOKIE, "", 0)],
  );
};

const signOut = async (env: Env, request: Request) => {
  const token = cookieValue(request.headers.get("cookie"), SESSION_COOKIE);
  if (token)
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?")
      .bind(await hmac(env, `session:${token}`))
      .run();
  return reply({ ok: true }, 200, [setCookie(SESSION_COOKIE, "", 0)]);
};

const me = async (env: Env, request: Request) => {
  const user = await sessionUser(env, request.headers.get("cookie"));
  return user === null ? fail(401, "Not signed in.") : reply({ email: user.email });
};

/** Routes /v1/auth/* and /v1/me; null for any other path. */
export const handleAuth = (env: Env, request: Request): Promise<Response> | null => {
  const { pathname } = new URL(request.url);
  const post = request.method === "POST";
  if (pathname === "/v1/auth/start" && post) return start(env, request);
  if (pathname === "/v1/auth/verify" && post) return verify(env, request);
  if (pathname === "/v1/auth/signout" && post) return signOut(env, request);
  if (pathname === "/v1/me" && request.method === "GET") return me(env, request);
  return null;
};

/** Hourly: drops uploads of sign-ins that never completed, old logins and expired sessions. */
export const cleanUpAuth = async (env: Env) => {
  const dayAgo = Date.now() - 24 * 3_600_000;
  await deleteExpiredUploads(env, dayAgo);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM logins WHERE created_at < ?").bind(dayAgo),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
  ]);
};
