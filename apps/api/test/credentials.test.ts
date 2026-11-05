import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CredentialsUnreadable, decryptCredentials, encryptCredentials } from "../src/credentials.ts";

const secret = btoa("k".repeat(32));

describe("decryptCredentials", () => {
  it("round-trips", async () => {
    const { iv, ciphertext } = await Effect.runPromise(encryptCredentials(secret, "run", { REDUCTO_API_KEY: "r" }));
    expect(await Effect.runPromise(decryptCredentials(secret, "run", iv, ciphertext))).toEqual({ REDUCTO_API_KEY: "r" });
  });

  it("fails as CredentialsUnreadable under another key or run", async () => {
    const { iv, ciphertext } = await Effect.runPromise(encryptCredentials(secret, "run", { REDUCTO_API_KEY: "r" }));
    await expect(Effect.runPromise(decryptCredentials(btoa("x".repeat(32)), "run", iv, ciphertext))).rejects.toBeInstanceOf(
      CredentialsUnreadable,
    );
    await expect(Effect.runPromise(decryptCredentials(secret, "other", iv, ciphertext))).rejects.toBeInstanceOf(
      CredentialsUnreadable,
    );
    await expect(Effect.runPromise(decryptCredentials(secret, "run", "not base64!", ciphertext))).rejects.toBeInstanceOf(
      CredentialsUnreadable,
    );
  });
});
