/// <reference types="node" />

import { timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanUpAuth, handleAuth, pendingLogin, sessionUser } from "../src/auth.ts";
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
    AUTH_KEY: "test-key-test-key-test-key-test-key",
    PUBLIC_URL: "https://parsejudge.test",
    EMAIL_FROM: "noreply@parsejudge.test",
    AUTH_MODE: "email",
    CREDENTIALS_KEY: btoa("c".repeat(32)),
    BLOB_SIGNING_KEY: "test-blob-key",
    JUDGE_REASONING_EFFORT: "medium",
    MAX_PAGES_PER_RUN: "1000",
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
  return { login: cookiePair(started.setCookies, "__Host-pj_login"), code, token, mail };
};

describe("email sign-in", () => {
  it("emails a code and a link and stores neither in plain text", async () => {
    const { login, code, token, mail } = await startLogin();
    expect(mail.to).toBe("ada@example.com");
    expect(code).toMatch(/^\d{6}$/);
    expect(login).toMatch(/^__Host-pj_login=[\w-]+\.[\w-]+$/);
    const row = JSON.stringify(db.prepare("SELECT * FROM logins").get());
    expect(row).not.toContain(code);
    expect(row).not.toContain(token.split(".")[1]);
  });

  it("signs in with the code in the browser that asked, with a secure session cookie", async () => {
    const { login, code } = await startLogin();
    const verified = await call("/v1/auth/verify", { code }, login);
    expect(verified.status).toBe(200);
    expect(verified.body.email).toBe("ada@example.com");
    const session = verified.setCookies.find((c) => c.startsWith("__Host-pj_session="));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Lax");
    const me = await call("/v1/me", undefined, cookiePair(verified.setCookies, "__Host-pj_session"));
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
    expect((await call("/v1/auth/verify", { code: wrong }, login)).body.error).toContain("Too many wrong codes");
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(400);
  });

  it("refuses an expired login", async () => {
    const { login, code } = await startLogin();
    db.exec("UPDATE logins SET expires_at = 0");
    expect((await call("/v1/auth/verify", { code }, login)).status).toBe(400);
  });

  it("limits sign-in emails per address and IP, per address, and per IP", async () => {
    for (let i = 0; i < 5; i++) await startLogin();
    expect((await call("/v1/auth/start", { email: "ada@example.com" })).status).toBe(429);
    // Another client can still sign the address in: one attacker cannot lock the owner out.
    expect((await call("/v1/auth/start", { email: "ada@example.com" }, "", "2.2.2.2")).status).toBe(200);
    for (let i = 0; i < 15; i++) await call("/v1/auth/start", { email: `u${i}@example.com` });
    expect((await call("/v1/auth/start", { email: "new@example.com" })).status).toBe(429);
  });

  it("counts gmail dots and +tags, and an IPv6 /64, as one", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call("/v1/auth/start", { email: `v.ic.tim+${i}@gmail.com` }, "", `2001:db8:1:2::${i}`)).status).toBe(200);
    }
    expect((await call("/v1/auth/start", { email: "victim@gmail.com" }, "", "2001:db8:1:2:ffff::1")).status).toBe(429);
    expect(sent.at(-1)?.to).toBe("v.ic.tim+4@gmail.com");
  });

  it("refuses reserved addresses, including the pending-upload owner", async () => {
    for (const email of ["pending@parsejudge.invalid", "a@b.test", "a@b.localhost"]) {
      expect((await call("/v1/auth/start", { email })).status).toBe(400);
    }
  });

  it("stops codes for an address after 10 wrong ones across its logins", async () => {
    for (let i = 0; i < 2; i++) {
      const { login, code } = await startLogin();
      const wrong = code === "000000" ? "111111" : "000000";
      for (let j = 0; j < 5; j++) await call("/v1/auth/verify", { code: wrong }, login, `9.9.9.${i}`);
    }
    const { login, code, token } = await startLogin();
    expect((await call("/v1/auth/verify", { code }, login)).body.error).toContain("Use the link");
    expect((await call("/v1/auth/verify", { token })).status).toBe(200);
  });

  it("reading the link does not use it", async () => {
    const { login, token } = await startLogin();
    const peek = await call("/v1/auth/link", { token });
    expect(peek.body).toEqual({ email: "ada@example.com", documents: [], sameBrowser: false });
    expect((await call("/v1/auth/link", { token }, login)).body.sameBrowser).toBe(true);
    expect((await call("/v1/auth/link", { token: `${token}x` })).status).toBe(400);
    expect((await call("/v1/auth/verify", { token })).status).toBe(200);
    expect((await call("/v1/auth/link", { token })).status).toBe(400);
  });

  it("discard signs in and leaves the carried-over files behind", async () => {
    const { login, token } = await startLogin();
    db.prepare(
      "INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at) VALUES ('d1', 'pending', ?, 'a.pdf', 'pdf', 'x', 1, 1)",
    ).run(await pendingLogin(env, login));
    const verified = await call("/v1/auth/verify", { token, discard: true });
    expect(verified.status).toBe(200);
    expect((verified.body.draft as { documents: unknown[] }).documents).toEqual([]);
    expect(db.prepare("SELECT user_id FROM documents WHERE id = 'd1'").get()).toEqual({ user_id: "pending" });
  });

  it("a new email from the same browser takes over the earlier sign-in's files", async () => {
    const first = await startLogin("a@example.com");
    db.prepare(
      "INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at) VALUES ('d1', 'pending', ?, 'a.pdf', 'pdf', 'x', 1, 1)",
    ).run(await pendingLogin(env, first.login));
    const again = await call("/v1/auth/start", { email: "b@example.com" }, first.login);
    const second = cookiePair(again.setCookies, "__Host-pj_login");
    expect(await pendingLogin(env, first.login)).toBeNull();
    expect((await call("/v1/auth/verify", { token: first.token })).status).toBe(400);
    const verified = await call("/v1/auth/verify", { code: /\b(\d{6})\b/.exec(sent.at(-1)?.subject ?? "")?.[1] }, second);
    expect((verified.body.draft as { documents: unknown[] }).documents).toHaveLength(1);
  });

  it("an upload still running under the replaced sign-in is carried over", async () => {
    const first = await startLogin("a@example.com");
    const firstId = await pendingLogin(env, first.login);
    const again = await call("/v1/auth/start", { email: "a@example.com" }, first.login);
    const second = cookiePair(again.setCookies, "__Host-pj_login");
    db.prepare(
      "INSERT INTO documents (id, user_id, login_id, filename, format, sha256, page_count, created_at) VALUES ('late', 'pending', ?, 'a.pdf', 'pdf', 'x', 1, 1)",
    ).run(firstId);
    const verified = await call("/v1/auth/verify", { code: /\b(\d{6})\b/.exec(sent.at(-1)?.subject ?? "")?.[1] }, second);
    expect((verified.body.draft as { documents: unknown[] }).documents).toHaveLength(1);
    expect(db.prepare("SELECT user_id FROM documents WHERE id = 'late'").get()).not.toEqual({ user_id: "pending" });
    expect(db.prepare("SELECT user_id FROM logins WHERE id = ?").get(firstId)).not.toEqual({ user_id: null });
  });

  it("the link page says when the link was used", async () => {
    const { token } = await startLogin();
    await call("/v1/auth/verify", { token });
    expect((await call("/v1/auth/link", { token })).body.error).toContain("already used");
  });

  it("tells the asking browser when the link was used elsewhere", async () => {
    const { login, code, token } = await startLogin();
    await call("/v1/auth/verify", { token });
    expect((await call("/v1/auth/verify", { code }, login)).body.error).toContain("already signed in");
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
    const user = await sessionUser(env, cookiePair(verified.setCookies, "__Host-pj_session"));
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
    const session = cookiePair((await call("/v1/auth/verify", { code }, login)).setCookies, "__Host-pj_session");
    await call("/v1/auth/signout", {}, session);
    expect(await sessionUser(env, session)).toBeNull();
  });
});

describe("cleanUpAuth", () => {
  it("still deletes expired sessions when the upload sweep fails, then rejects", async () => {
    db.prepare("INSERT INTO users (id, email, created_at) VALUES ('u', 'a@b.com', 0)").run();
    db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ('h', 'u', 0, 1)").run();
    db.prepare(
      "INSERT INTO documents (id, user_id, filename, format, sha256, page_count, created_at) VALUES ('old', 'pending', 'a.pdf', 'pdf', 'x', 1, 1)",
    ).run();
    env = { ...env, BLOBS: { delete: () => Promise.reject(new Error("R2 down")) } } as unknown as Env;
    await expect(cleanUpAuth(env)).rejects.toMatchObject({ _tag: "CleanUpFailed", step: "uploads" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });
});
