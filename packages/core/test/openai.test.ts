import { Cause, Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokenCache, workloadToken } from "../src/openai.ts";

const identity = { authUrl: "https://auth.test/oauth/token", identityProviderId: "idp_1", serviceAccountId: "user-1" };

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

  it("exchanges the certificate once and reuses the token until near expiry", async () => {
    const { bodies, run } = exchange(() => new Response(JSON.stringify({ access_token: "t1", expires_in: 3600 })));
    expect(String(await run())).toContain("t1");
    expect(String(await run())).toContain("t1");
    expect(bodies).toEqual([
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:openai:params:oauth:token-type:x509",
        identity_provider_id: "idp_1",
        service_account_id: "user-1",
      },
    ]);
  });

  it("renews a token that expires within 5 minutes", async () => {
    const { bodies, run } = exchange(() => new Response(JSON.stringify({ access_token: "t", expires_in: 60 })));
    await run();
    await run();
    expect(bodies).toHaveLength(2);
  });

  it("fails without retry on a rejected certificate, with retry on 5xx", async () => {
    const rejected = exchange(
      () => new Response(JSON.stringify({ error: { code: "invalid_subject_token" } }), { status: 401 }),
    ).run();
    expect(retryable(await rejected)).toBe(false);
    expect(String(await rejected)).toContain("invalid_subject_token");
    expect(retryable(await exchange(() => new Response("", { status: 503 })).run())).toBe(true);
  });
});
