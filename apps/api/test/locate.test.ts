import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { checkQuotes, locate, visibleText } from "../src/locate.ts";

const OUTPUT = "| Site | Throughput |\n|---|---|\n| Gdansk | 14,210 |\n\nThroughput rose at two of three sites.";
const FLAGS = [{ category: "table_structure", severity: "low", description: "Header cell split" }];
const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
const env = {
  OPENAI_BASE_URL: "https://openai.test/v1",
  OPENAI_AUTH_URL: "https://auth.test/oauth/token",
  OPENAI_IDENTITY_PROVIDER_ID: "idp_locate",
  OPENAI_SERVICE_ACCOUNT_ID: "user-locate",
  OPENAI_JWT_ISSUER: "https://issuer.test",
  OPENAI_JWT_AUDIENCE: "https://openai.test/v1",
  OPENAI_JWT_SUBJECT: "spiffe://issuer.test/worker",
  OPENAI_SIGNING_KEY: JSON.stringify({ ...(await crypto.subtle.exportKey("jwk", keyPair.privateKey)), kid: "k1" }),
  SMALL_MODEL: "m",
} as unknown as Env;

const token = () => new Response(JSON.stringify({ access_token: "t", expires_in: 300 }));

/** Answers the token exchange, and each completion with the next reply. */
const stubFetch = (next: () => Response) => {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
    String(url).startsWith(env.OPENAI_AUTH_URL) ? token() : next(),
  );
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.filter(([url]) => String(url).startsWith(env.OPENAI_BASE_URL));
};

const reply = (errors: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ errors }) } }] }));

/** FetchHttpClient over the fetch stubbed for this test. */
const withFetch = Effect.provide(
  Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch),
  ),
);

afterEach(() => vi.unstubAllGlobals());

describe("checkQuotes", () => {
  const text = visibleText(OUTPUT);
  it("accepts an excerpt that appears once", () => {
    expect(checkQuotes(text, [{ text: "Gdansk", occurrence: 1 }])).toEqual([]);
  });
  it("asks which match when an excerpt repeats, and accepts a valid occurrence", () => {
    expect(checkQuotes(text, [{ text: "Throughput", occurrence: 3 }])[0]).toContain("appears 2 times");
    expect(checkQuotes(text, [{ text: "Throughput", occurrence: 2 }])).toEqual([]);
  });
  it("rejects text that is not in the output or that carries Markdown", () => {
    expect(checkQuotes(text, [{ text: "Tallinn", occurrence: 1 }])[0]).toContain("not in the output");
    expect(checkQuotes(text, [{ text: "| Site |", occurrence: 1 }])[0]).toContain("Markdown");
  });
  it("matches HTML output by its visible text", () => {
    expect(checkQuotes(visibleText("<td>R&amp;D</td>"), [{ text: "R&D", occurrence: 1 }])).toEqual([]);
  });
  it("rejects an excerpt the viewer cannot mark because it crosses a link or an escape", () => {
    expect(checkQuotes(visibleText("Mail a@b.co I now"), [{ text: "a@b.co I now", occurrence: 1 }])).toHaveLength(1);
    expect(checkQuotes(visibleText("4\\. Dismissed"), [{ text: "4. Dismissed", occurrence: 1 }])).toEqual([]);
  });
});

describe("locate", () => {
  it("sends problems back to the model until the excerpt matches one place", async () => {
    const replies = [
      reply([{ error: 1, quotes: [{ text: "Throughput", occurrence: 5 }] }]),
      reply([{ error: 1, quotes: [{ text: "Throughput", occurrence: 1 }] }]),
    ];
    const completions = stubFetch(() => replies.shift() ?? new Response("", { status: 500 }));
    expect(await Effect.runPromise(locate(env, OUTPUT, FLAGS).pipe(withFetch))).toEqual([
      [{ text: "Throughput", occurrence: 1 }],
    ]);
    expect(completions()).toHaveLength(2);
    const body = completions()[1]?.[1]?.body as Uint8Array;
    const second = JSON.parse(new TextDecoder().decode(body)).messages.at(-1).content as string;
    expect(second).toContain("appears 2 times");
  });

  it("keeps only valid excerpts when the rounds run out", async () => {
    stubFetch(() =>
      reply([
        {
          error: 1,
          quotes: [
            { text: "Gdansk", occurrence: 1 },
            { text: "nowhere", occurrence: 1 },
          ],
        },
      ]),
    );
    expect(await Effect.runPromise(locate(env, OUTPUT, FLAGS).pipe(withFetch))).toEqual([[{ text: "Gdansk", occurrence: 1 }]]);
  });
});
