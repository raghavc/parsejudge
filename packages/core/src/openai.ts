import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { JudgeError } from "./errors.ts";
import { httpErrorMessage, snippet } from "./http.ts";

/** OpenAI X.509 workload identity: the HttpClient must present the client certificate (a Worker mTLS binding). */
export interface WorkloadIdentity {
  readonly authUrl: string;
  readonly identityProviderId: string;
  readonly serviceAccountId: string;
}

const Token = Schema.Struct({ access_token: Schema.NonEmptyString, expires_in: Schema.Number });

/** Renew this long before expiry so no request goes out with a token about to lapse. */
const RENEW_BEFORE_MS = 5 * 60_000;

const cache = new Map<string, { readonly token: string; readonly expiresAt: number }>();

/** Exchanges the client certificate for a short-lived bearer token, cached per isolate until near expiry. */
export const workloadToken = Effect.fn("openai.token")(function* (identity: WorkloadIdentity) {
  const key = `${identity.identityProviderId}:${identity.serviceAccountId}`;
  const cached = cache.get(key);
  if (cached !== undefined && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.token;
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.post(identity.authUrl).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:openai:params:oauth:token-type:x509",
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
    // 400/401 mean the certificate, provider or mapping is wrong; retrying will not fix that.
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
