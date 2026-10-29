/// <reference types="node" />

import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAuth, pendingLogin, sessionUser } from "../src/auth.ts";
import type { Env } from "../src/env.ts";

// Workers-only API.
(crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }).timingSafeEqual = (a, b) =>
  timingSafeEqual(a, b);

/** The slice of D1 that auth.ts uses, over node:sqlite. */
const d1 = (db: DatabaseSync) => {
  const statement = (sql: string, args: ReadonlyArray<unknown> = []) => ({
    bind: (...next: ReadonlyArray<unknown>) => statement(sql, next),
    first: async () => (db.prepare(sql).get(...(args as [])) as unknown) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as [])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(args as [])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReadonlyArray<ReturnType<typeof statement>>) => Promise.all(statements.map((s) => s.run())),
  };
};

const migrations = join(import.meta.dirname, "../migrations");
let db: DatabaseSync;
let sent: Array<{ to: string; subject: string; text: string }>;
let env: Env;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrations).sort()) db.exec(readFileSync(join(migrations, file), "utf8"));
  sent = [];
  env = {
    DB: d1(db),
    AUTH_KEY: "test-key",
    PUBLIC_URL: "https://parsejudge.test",
    EMAIL_FROM: "noreply@parsejudge.test",
    EMAIL: { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) },
  } as unknown as Env;
});

const call = async (path: string, body?: unknown, cookies = "", ip = "1.1.1.1") => {
  const response = await handleAuth(
    env,
    new Request(`https://parsejudge.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie: cookies, "cf-connecting-ip": ip },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  if (response === null) throw new Error(`no route ${path}`);
  const setCookies = response.headers.getSetCookie();
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, setCookies };
};
const cookiePair = (setCookies: ReadonlyArray<string>, name: string) =>
  setCookies.find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

const startLogin = async (email = "Ada@Example.com") => {
  const started = await call("/v1/auth/start", { email, presetIds: ["reducto_r1"] });
  expect(started.status).toBe(200);
  const mail = sent.at(-1);
  if (mail === undefined) throw new Error("no email");
  const code = /\b(\d{6})\b/.exec(mail.subject)?.[1] ?? "";
  const token = /token=([^\s]+)/.exec(mail.text)?.[1] ?? "";
  return { login: cookiePair(started.setCookies, "pj_login"), code, token, mail };
};

describe("email sign-in", () => {
  it("emails a code and a link and stores neither in plain text", async () => {
    const { login, code, token, mail } = await startLogin();
    expect(mail.to).toBe("ada@example.com");
    expect(code).toMatch(/^\d{6}$/);
    expect(login).toMatch(/^pj_login=[\w-]+\.[\w-]+$/);
    const row = JSON.stringify(db.prepare("SELECT * FROM logins").get());
    expect(row).not.toContain(code);
    expect(row).not.toContain(token.split(".")[1]);
  });

  it("signs in with the code in the browser that asked, with a secure session cookie", async () => {
    const { login, code } = await startLogin();
    const verified = await call("/v1/auth/verify", { code }, login);
    expect(verified.status).toBe(200);
    expect(verified.body.email).toBe("ada@example.com");
    const session = verified.setCookies.find((c) => c.startsWith("pj_session="));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    const me = await call("/v1/me", undefined, cookiePair(verified.setCookies, "pj_session"));
    expect(me.body.email).toBe("ada@example.com");
  });

  it("refuses the code without the asking browser's cookie", async () => {
    const { code } = await startLogin();
    expect((await call("/v1/auth/verify", { code })).status).toBe(400);
  });

  it("works once: neither the code nor the link signs in again", async () => {
    const { login, code, token } = await startLogin();
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(200);
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(400);
    expect((await call("/v1/auth/verify", { token })).status).toBe(400);
  });

  it("locks the login after 5 wrong codes", async () => {
    const { login, code } = await startLogin();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 4; i >= 1; i--) {
      const r = await call("/v1/auth/verify", { code: wrong }, login);
      expect(r.body.error).toContain(`${i} ${i === 1 ? "try" : "tries"} left`);
    }
    expect((await call("/v1/auth/verify", { code: wrong }, login)).body.error).toContain("expired");
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(400);
  });

  it("refuses an expired login", async () => {
    const { login, code } = await startLogin();
    db.exec("UPDATE logins SET expires_at = 0");
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(400);
  });

  it("limits sign-in emails per address and per IP", async () => {
    for (let i = 0; i < 5; i++) await startLogin();
    expect((await call("/v1/auth/start", { email: "ada@example.com" }, "", "2.2.2.2")).status).toBe(429);
    for (let i = 0; i < 15; i++) await call("/v1/auth/start", { email: `u${i}@example.com` });
    expect((await call("/v1/auth/start", { email: "new@example.com" })).status).toBe(429);
  });

  it("the link in another browser keeps the files uploaded before sign-in", async () => {
    const { login, token } = await startLogin();
    const loginId = await pendingLogin(env, login);
    expect(loginId).not.toBeNull();
    db.prepare(
      "INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at) VALUES ('d1', 'pending', ?, 'a.pdf', 'pdf', 'x', 3, 1)",
    ).run(loginId);
    const verified = await call("/v1/auth/verify", { token });
    expect(verified.status).toBe(200);
    expect(verified.body.draft).toEqual({
      presetIds: ["reducto_r1"],
      documents: [{ documentId: "d1", filename: "a.pdf", format: "pdf", pageCount: 3 }],
    });
    const user = await sessionUser(env, cookiePair(verified.setCookies, "pj_session"));
    expect(db.prepare("SELECT user_id FROM documents WHERE id = 'd1'").get()).toEqual({ user_id: user?.id });
    expect(await pendingLogin(env, login)).toBeNull();
  });

  it("another login cannot claim a pending upload", async () => {
    const first = await startLogin("a@example.com");
    const firstId = await pendingLogin(env, first.login);
    db.prepare(
      "INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at) VALUES ('d1', 'pending', ?, 'a.pdf', 'pdf', 'x', 1, 1)",
    ).run(firstId);
    const second = await startLogin("b@example.com");
    const verified = await call("/v1/auth/verify", { token: second.token });
    expect((verified.body.draft as { documents: unknown[] }).documents).toEqual([]);
    expect(db.prepare("SELECT user_id FROM documents WHERE id = 'd1'").get()).toEqual({ user_id: "pending" });
  });

  it("sign out ends the session", async () => {
    const { login, code } = await startLogin();
    const session = cookiePair((await call("/v1/auth/verify", { code }, login)).setCookies, "pj_session");
    await call("/v1/auth/signout", {}, session);
    expect(await sessionUser(env, session)).toBeNull();
  });
});
