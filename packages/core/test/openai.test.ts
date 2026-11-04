import { Cause, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, workloadToken } from "../src/openai.ts";

const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const jwk = (await crypto.subtle.exportKey("jwk", keyPair.privateKey)) as JsonWebKey;

const identity = {
  authUrl: "https://auth.test/oauth/token",
  identityProviderId: "idp_1",
  serviceAccountId: "user-1",
  issuer: "https://issuer.test",
  audience: "https://api.openai.com/v1",
  subject: "spiffe://issuer.test/judge",
  signingKey: JSON.stringify({ ...jwk, kid: "k1" }),
};

const fromBase64url = (part: string) =>
  Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

const exchange = (respond: () => Response) => {
  const bodies: Array<unknown> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return respond();
  }) as unknown as typeof globalThis.fetch;
  const run = () =>
    Effect.runPromiseExit(
      workloadToken(identity).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
      ),
    );
  return { bodies, run };
};

const retryable = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { retryable?: boolean }).retryable : undefined;

describe("workloadToken", () => {
  beforeEach(clearTokenCache);

  it("exchanges a signed JWT once and reuses the token until near expiry", async () => {
    const { bodies, run } = exchange(() => new Response(JSON.stringify({ access_token: "t1", expires_in: 300 })));
    expect(String(await run())).toContain("t1");
    expect(String(await run())).toContain("t1");
    expect(bodies).toHaveLength(1);
    const { subject_token, ...rest } = bodies[0] as { subject_token: string };
    expect(rest).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:openai:params:oauth:token-type:jwt",
      identity_provider_id: "idp_1",
      service_account_id: "user-1",
    });
    const [header, payload, signature] = subject_token.split(".") as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(header)))).toEqual({ alg: "ES256", typ: "JWT", kid: "k1" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    expect(claims).toMatchObject({ iss: identity.issuer, aud: identity.audience, sub: identity.subject });
    expect(claims.exp - claims.iat).toBe(300);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.publicKey,
      fromBase64url(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it("renews a token that expires within a minute", async () => {
    const { bodies, run } = exchange(() => new Response(JSON.stringify({ access_token: "t", expires_in: 30 })));
    await run();
    await run();
    expect(bodies).toHaveLength(2);
  });

  it("fails without retry on a rejected JWT or bad key, with retry on 5xx", async () => {
    const rejected = exchange(
      () => new Response(JSON.stringify({ error: { code: "invalid_subject_token" } }), { status: 401 }),
    ).run();
    expect(retryable(await rejected)).toBe(false);
    expect(String(await rejected)).toContain("invalid_subject_token");
    expect(retryable(await exchange(() => new Response("", { status: 503 })).run())).toBe(true);
    const badKey = await Effect.runPromiseExit(
      workloadToken({ ...identity, identityProviderId: "idp_2", signingKey: "{}" }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
    expect(retryable(badKey)).toBe(false);
  });
});
