import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { JudgeError } from "./errors.ts";
import { httpErrorMessage, snippet } from "./http.ts";

/**
 * OpenAI OIDC workload identity. We sign a short-lived JWT with our own ES256 key; OpenAI's identity
 * provider holds the matching public JWKS and maps `sub` to a project service account.
 */
export interface WorkloadIdentity {
  readonly authUrl: string;
  readonly identityProviderId: string;
  readonly serviceAccountId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  /** Private P-256 JWK as JSON, with `kid`. */
  readonly signingKey: string;
}

const Token = Schema.Struct({ access_token: Schema.NonEmptyString, expires_in: Schema.Number });

const SigningKey = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
  kid: Schema.NonEmptyString,
});

/** OpenAI tokens last 5 minutes; renew with a minute left so no request goes out with a lapsing token. */
const RENEW_BEFORE_MS = 60_000;
const JWT_LIFETIME_S = 300;

const cache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

const base64url = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

const keyError = (message: string) => new JudgeError({ retryable: false, message: `OpenAI signing key: ${message}` });

/** Signs the subject JWT OpenAI exchanges for an access token. */
export const subjectToken = Effect.fn("openai.subjectToken")(function* (identity: WorkloadIdentity) {
  const jwk = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SigningKey))(identity.signingKey).pipe(
    Effect.mapError((error) => keyError(error.message)),
  );
  const key = yield* Effect.tryPromise({
    try: () => crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]),
    catch: (error) => keyError(String(error)),
  });
  const now = Math.floor(Date.now() / 1000);
  const input = `${encodeJson({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encodeJson({
    iss: identity.issuer,
    aud: identity.audience,
    sub: identity.subject,
    iat: now,
    exp: now + JWT_LIFETIME_S,
    jti: crypto.randomUUID(),
  })}`;
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input)),
    catch: (error) => keyError(String(error)),
  });
  return `${input}.${base64url(new Uint8Array(signature))}`;
});

/** Exchanges a signed JWT for a short-lived bearer token, cached per isolate until near expiry. */
export const workloadToken = Effect.fn("openai.token")(function* (identity: WorkloadIdentity) {
  const key = `${identity.identityProviderId}:${identity.serviceAccountId}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.token;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(identity.authUrl).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: yield* subjectToken(identity),
      subject_token_type: "urn:openai:params:oauth:token-type:jwt",
      identity_provider_id: identity.identityProviderId,
      service_account_id: identity.serviceAccountId,
    }),
  );
  const { status, text } = yield* Effect.gen(function* () {
    const response = yield* client.execute(request);
    return { status: response.status, text: yield* response.text };
  }).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: `OpenAI token exchange: ${httpErrorMessage(error)}` })),
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new JudgeError({ retryable: true, message: "OpenAI token exchange timed out" })),
    }),
  );
  if (status !== 200) {
    // 400/401 mean the key, provider or mapping is wrong; retrying will not fix that.
    return yield* new JudgeError({
      retryable: status === 429 || status >= 500,
      message: `OpenAI token exchange HTTP ${status}: ${snippet(text)}`,
    });
  }
  const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Token))(text).pipe(
    Effect.mapError((error) => new JudgeError({ retryable: true, message: `Invalid OpenAI token response: ${error.message}` })),
  );
  cache.set(key, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
});

/** For tests. */
export const clearTokenCache = () => cache.clear();
