import { Effect } from "effect";

const encoder = new TextEncoder();

const hmac = (secret: string, message: string) =>
  Effect.promise(() =>
    crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ).pipe(
    Effect.flatMap((key) => Effect.promise(() => crypto.subtle.sign("HMAC", key, encoder.encode(message)))),
    Effect.map((signature) => [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("")),
  );

/** A public, expiring URL for an R2 object, so providers can fetch a page without our credentials. */
export const signedBlobUrl = (publicUrl: string, secret: string, key: string, ttlSeconds = 3600) => {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  return hmac(secret, `${key}:${expires}`).pipe(
    Effect.map((signature) => `${publicUrl.replace(/\/+$/, "")}/blobs/${key}?exp=${expires}&sig=${signature}`),
  );
};

export const verifyBlobUrl = (secret: string, key: string, expires: string | null, signature: string | null) =>
  expires === null || signature === null || Number(expires) < Date.now() / 1000
    ? Effect.succeed(false)
    : hmac(secret, `${key}:${expires}`).pipe(Effect.map((expected) => expected === signature));
