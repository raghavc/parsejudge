import { readFileSync } from "node:fs";
import { Effect, Exit, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import type { Credentials, PageInput } from "../src/provider.ts";
import { PROVIDERS } from "../src/providers/index.ts";

const page: PageInput = { imageUrl: "https://pages.test/p.png", image: Effect.succeed(new Uint8Array([1])) };
const credentials: Credentials = {
  REDUCTO_API_KEY: "k",
  MISTRAL_API_KEY: "k",
  PULSE_API_KEY: "k",
  LLAMA_CLOUD_API_KEY: "k",
  AZURE_DI_KEY: "k",
  COHERE_API_KEY: "k",
};

/** Runs an adapter call against a fetch that always answers `respond()`. */
const run = <A, E>(effect: Effect.Effect<A, E, import("effect/http").HttpClient.HttpClient>, respond: () => Response) =>
  Effect.runPromiseExit(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, (async () => respond()) as unknown as typeof globalThis.fetch)),
    ),
  );

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

const poll = (provider: keyof typeof PROVIDERS, body: unknown) => {
  const adapter = PROVIDERS[provider];
  if (adapter.poll === undefined) throw new Error(`${provider} cannot poll`);
  return run(adapter.poll("https://jobs.test/job-1", credentials), json(body));
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`);
  return String(exit.cause);
};

describe("provider adapters", () => {
  it("fail on a 200 body without the parse instead of returning empty markdown", async () => {
    const exit = await run(PROVIDERS.mistral_ocr.submit(page, {}, credentials), json({ detail: "model overloaded" }));
    expect(failureOf(exit)).toContain("model overloaded");
  });

  it("keep the network error behind a transport failure", async () => {
    const exit = await run(PROVIDERS.mistral_ocr.submit(page, {}, credentials), () => {
      throw new TypeError("Network connection lost");
    });
    expect(failureOf(exit)).toContain("Network connection lost");
  });

  it("stop polling a job that ended without a result, with the provider's error", async () => {
    expect(failureOf(await poll("pulse", { status: "canceled", error: "canceled by user" }))).toContain(
      "job canceled: canceled by user",
    );
    expect(failureOf(await poll("reducto", { status: "Cancelled", reason: "stopped" }))).toContain("job Cancelled: stopped");
    expect(
      failureOf(
        await poll("azure_document_intelligence", { status: "failed", error: { code: "InvalidContent", message: "bad image" } }),
      ),
    ).toContain("InvalidContent bad image");
  });

  it("keep polling a job that is still running", async () => {
    expect(await poll("reducto", { status: "InProgress" })).toEqual(Exit.succeed(Option.none()));
  });

  it("fail a LlamaParse job whose page failed", async () => {
    const exit = await poll("llamaparse", {
      job: { status: "COMPLETED" },
      markdown: { pages: [{ page_number: 1, success: false, error: "OCR timeout" }] },
    });
    expect(failureOf(exit)).toContain("OCR timeout");
  });

  it("keep the LlamaParse page header, which comes apart from the page markdown (recorded response)", async () => {
    const recorded = JSON.parse(
      readFileSync(new URL("fixtures/responses/llamaparse-agentic-header.json", import.meta.url), "utf8"),
    );
    const exit = await poll("llamaparse", recorded);
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    expect(Option.getOrThrow(exit.value).markdown).toMatch(
      /^MONETARY POLICY REPORT: JULY 2024 47\n\n## \*\*Developments in the Federal Reserve/,
    );
  });

  it("decode a completed Reducto job", async () => {
    const exit = await poll("reducto", {
      status: "Completed",
      result: { result: { type: "full", chunks: [{ content: "# A" }, { content: "B" }] }, usage: { credits: 2 } },
    });
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    expect(Option.getOrThrow(exit.value).markdown).toBe("# A\n\nB");
  });
  it("keep Cohere output cut off at MAX_TOKENS, with a warning (recorded W-9 response)", async () => {
    const recorded = JSON.parse(readFileSync(new URL("fixtures/responses/cohere-max-tokens.json", import.meta.url), "utf8"));
    const exit = await run(PROVIDERS.cohere.submit(page, {}, credentials), json(recorded));
    if (Exit.isFailure(exit) || exit.value._tag !== "Done") throw new Error("expected a finished parse");
    expect(exit.value.output.markdown).toContain("1 Name of entity/individual.");
    expect(exit.value.output.warning).toContain("MAX_TOKENS");
  });
});
