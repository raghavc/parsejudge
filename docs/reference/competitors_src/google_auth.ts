import { HttpError, isRecord } from "./schema";
import type { Env } from "./types";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_REFRESH_BUFFER_SECONDS = 60;

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

interface ServiceAccountCredentials {
  clientEmail: string;
  privateKey: string;
  projectId: string;
}

let cachedAccessToken: CachedAccessToken | null = null;

export async function googleAccessToken(env: Env): Promise<string> {
  if (cachedAccessToken !== null && cachedAccessToken.expiresAtMs > Date.now()) {
    return cachedAccessToken.token;
  }

  const credentials = parseServiceAccountCredentials(env.GOOGLE_APPLICATION_CREDENTIALS);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const assertion = await signedJwt(credentials, nowSeconds);
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) {
    throw new HttpError(502, "PROVIDER_AUTH_ERROR", `Google OAuth request failed with status ${response.status}.`);
  }

  const raw: unknown = await response.json();
  if (!isRecord(raw) || typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new HttpError(502, "PROVIDER_AUTH_ERROR", "Google OAuth response did not include an access token.");
  }
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : 3600;
  cachedAccessToken = {
    token: raw.access_token,
    expiresAtMs: Date.now() + Math.max(0, expiresIn - TOKEN_REFRESH_BUFFER_SECONDS) * 1000,
  };
  return raw.access_token;
}

export function googleProjectId(env: Env): string {
  return env.GCP_PROJECT_ID || parseServiceAccountCredentials(env.GOOGLE_APPLICATION_CREDENTIALS).projectId;
}

function parseServiceAccountCredentials(raw: string): ServiceAccountCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(
      500,
      "SERVER_MISCONFIGURED",
      "GOOGLE_APPLICATION_CREDENTIALS must contain raw service account JSON.",
    );
  }
  if (
    !isRecord(value) ||
    typeof value.client_email !== "string" ||
    value.client_email.length === 0 ||
    typeof value.private_key !== "string" ||
    value.private_key.length === 0 ||
    typeof value.project_id !== "string" ||
    value.project_id.length === 0
  ) {
    throw new HttpError(
      500,
      "SERVER_MISCONFIGURED",
      "GOOGLE_APPLICATION_CREDENTIALS is missing client_email, private_key, or project_id.",
    );
  }
  return {
    clientEmail: value.client_email,
    privateKey: value.private_key,
    projectId: value.project_id,
  };
}

async function signedJwt(credentials: ServiceAccountCredentials, nowSeconds: number): Promise<string> {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const claims = base64UrlJson({
    iss: credentials.clientEmail,
    scope: GOOGLE_CLOUD_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  });
  const unsignedToken = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes(credentials.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsignedToken),
  );
  return `${unsignedToken}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function privateKeyBytes(pem: string): ArrayBuffer {
  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  if (encoded.length === 0) {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "Google service account private_key is invalid.");
  }
  try {
    const binary = atob(encoded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  } catch {
    throw new HttpError(500, "SERVER_MISCONFIGURED", "Google service account private_key is invalid.");
  }
}

function base64UrlJson(value: Record<string, string | number>): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function resetGoogleAccessTokenCacheForTests(): void {
  cachedAccessToken = null;
}
