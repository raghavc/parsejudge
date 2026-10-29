import type { Env } from "./env.ts";

const encoder = new TextEncoder();
const TTL_SECONDS = 3600;

const hmac = async (secret: string, message: string) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`upload:${message}`)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * A PUT URL that uploads files into a user's account for an hour, for agents that can't send our cookie.
 * Every file sent to it is tagged with its uploadId.
 */
export const signedUploadUrl = async (env: Env, userId: string) => {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const uploadId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const message = `${userId}.${uploadId}.${expiresAt}`;
  const token = `${message}.${await hmac(env.BLOB_SIGNING_KEY, message)}`;
  return { url: `${env.PUBLIC_URL.replace(/\/+$/, "")}/v1/uploads/${token}`, uploadId, expiresAt: expiresAt * 1000 };
};

/** The user and upload a token from signedUploadUrl is for, or null if it is forged or expired. */
export const uploadUser = async (env: Env, token: string): Promise<{ userId: string; uploadId: string } | null> => {
  const [userId, uploadId, expiresAt, signature, ...rest] = token.split(".");
  if (userId === undefined || uploadId === undefined || expiresAt === undefined || signature === undefined) return null;
  if (rest.length > 0 || Number(expiresAt) < Date.now() / 1000) return null;
  const valid = (await hmac(env.BLOB_SIGNING_KEY, `${userId}.${uploadId}.${expiresAt}`)) === signature;
  return valid ? { userId, uploadId } : null;
};
