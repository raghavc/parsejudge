import type { Env } from "./env.ts";

const encoder = new TextEncoder();
const TTL_SECONDS = 3600;

const hmac = async (secret: string, message: string) => {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`upload:${message}`)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** A PUT URL that uploads files into a user's account for an hour, for agents that can't send our cookie. */
export const signedUploadUrl = async (env: Env, userId: string) => {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const token = `${userId}.${expiresAt}.${await hmac(env.BLOB_SIGNING_KEY, `${userId}.${expiresAt}`)}`;
  return { url: `${env.PUBLIC_URL.replace(/\/+$/, "")}/v1/uploads/${token}`, expiresAt: expiresAt * 1000 };
};

/** The user a token from signedUploadUrl uploads for, or null if it is forged or expired. */
export const uploadUser = async (env: Env, token: string): Promise<string | null> => {
  const [userId, expiresAt, signature] = token.split(".");
  if (userId === undefined || expiresAt === undefined || signature === undefined) return null;
  if (Number(expiresAt) < Date.now() / 1000) return null;
  return (await hmac(env.BLOB_SIGNING_KEY, `${userId}.${expiresAt}`)) === signature ? userId : null;
};
