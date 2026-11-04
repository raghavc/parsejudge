import { describe, expect, it } from "vitest";
import { type Env, envError } from "../src/env.ts";

const valid = {
  PUBLIC_URL: "https://parsejudge.com",
  AUTH_MODE: "email",
  AUTH_KEY: "k".repeat(32),
  CREDENTIALS_KEY: btoa("c".repeat(32)),
  BLOB_SIGNING_KEY: "b",
  EMAIL_FROM: "noreply@parsejudge.com",
  JUDGE_REASONING_EFFORT: "medium",
  MAX_PAGES_PER_RUN: "1000",
  MAX_CONCURRENCY: '{"reducto": 200}',
};
const check = (overrides: Record<string, unknown>) => envError({ ...valid, ...overrides } as unknown as Env)?.message ?? null;

describe("envError", () => {
  it("accepts a complete deployment", () => {
    expect(check({})).toBeNull();
  });

  it.each([
    ["a short AUTH_KEY", { AUTH_KEY: "short" }, "AUTH_KEY"],
    ["a CREDENTIALS_KEY that is not 32 bytes", { CREDENTIALS_KEY: btoa("c".repeat(16)) }, "CREDENTIALS_KEY"],
    ["MAX_CONCURRENCY that is not JSON", { MAX_CONCURRENCY: "{reducto: 200}" }, "MAX_CONCURRENCY"],
    ["a zero concurrency limit", { MAX_CONCURRENCY: '{"judge": 0}' }, "judge"],
    ["a Turnstile site key without its secret", { TURNSTILE_SITEKEY: "0x4AAA" }, "TURNSTILE_SECRET"],
    ["a missing PUBLIC_URL", { PUBLIC_URL: undefined }, "PUBLIC_URL"],
  ])("rejects %s", (_, overrides, mentions) => {
    expect(check(overrides)).toContain(mentions);
  });
});
