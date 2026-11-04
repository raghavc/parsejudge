import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { signedUploadUrl, uploadUser } from "../src/uploads.ts";

const env = { PUBLIC_URL: "https://parsejudge.com/", BLOB_SIGNING_KEY: "test-key" } as unknown as Env;
const run = Effect.runPromise;
const tokenOf = (url: string) => url.slice(url.lastIndexOf("/") + 1);

describe("signed upload URLs", () => {
  it("upload for the user they were made for", async () => {
    const { url } = await run(signedUploadUrl(env, "user-1"));
    expect(url.startsWith("https://parsejudge.com/v1/uploads/")).toBe(true);
    const upload = await run(uploadUser(env, tokenOf(url)));
    expect(upload?.userId).toBe("user-1");
    expect(upload?.uploadId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("reject a token for another user or signed with another key", async () => {
    const token = tokenOf((await run(signedUploadUrl(env, "user-1"))).url);
    expect(await run(uploadUser(env, token.replace("user-1", "user-2")))).toBeNull();
    expect(await run(uploadUser({ ...env, BLOB_SIGNING_KEY: "other" } as Env, token))).toBeNull();
  });

  it("reject a token moved to another upload", async () => {
    const [userId, , expiresAt, signature] = tokenOf((await run(signedUploadUrl(env, "user-1"))).url).split(".");
    expect(await run(uploadUser(env, `${userId}.0000000000000000.${expiresAt}.${signature}`))).toBeNull();
  });

  it("reject an expired token", async () => {
    const [userId, uploadId, , signature] = tokenOf((await run(signedUploadUrl(env, "user-1"))).url).split(".");
    expect(await run(uploadUser(env, `${userId}.${uploadId}.1.${signature}`))).toBeNull();
  });
});
