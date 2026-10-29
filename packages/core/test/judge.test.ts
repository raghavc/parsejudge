import { Effect, Exit, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { describe, expect, it } from "vitest";
import { blindLabels, judgePage, unblind } from "../src/judge.ts";

const config = { apiKey: "test", model: "judge", reasoningEffort: "medium" as const, baseUrl: "https://judge.test/v1" };
const input = {
  pageId: "doc-0",
  imagePng: new Uint8Array([1, 2, 3]),
  markdownByPreset: { reducto_r1: "# A", aws_textract: "A" },
};

/** Runs the judge against a fake endpoint that answers with `evaluations(labels)`. */
const judgeWith = (evaluations: (labels: Array<string>) => unknown, status = 200) => {
  const fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const labels: Array<string> = body.response_format.json_schema.schema.properties.evaluations.items.properties.label.enum;
    const content = JSON.stringify({ evaluations: evaluations(labels) });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  }) as typeof globalThis.fetch;
  return Effect.runPromiseExit(
    judgePage(config, input).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    ),
  );
};

const evaluation = (label: string, score: number) => ({ label, score, reasoning: "r", errors: [] });

describe("blindLabels", () => {
  it("is deterministic per page and independent of input order", async () => {
    const a = await Effect.runPromise(blindLabels("doc-0", ["reducto_r1", "aws_textract", "llamaparse_agentic"]));
    const b = await Effect.runPromise(blindLabels("doc-0", ["llamaparse_agentic", "reducto_r1", "aws_textract"]));
    expect(a).toEqual(b);
    expect(Object.keys(a)).toEqual(["parse_a", "parse_b", "parse_c"]);
    expect(new Set(Object.values(a))).toEqual(new Set(["reducto_r1", "aws_textract", "llamaparse_agentic"]));
  });
});

describe("judgePage", () => {
  it("maps blinded labels back to presets", async () => {
    const labels = await Effect.runPromise(blindLabels(input.pageId, Object.keys(input.markdownByPreset)));
    const exit = await judgeWith((ids) => ids.map((id) => evaluation(id, labels[id] === "reducto_r1" ? 9 : 4)));
    if (Exit.isFailure(exit)) throw new Error(String(exit.cause));
    if (Exit.isSuccess(exit)) {
      expect(Object.fromEntries(exit.value.map((v) => [v.presetId, v.score]))).toEqual({ reducto_r1: 9, aws_textract: 4 });
    }
  });

  it("fails when the judge skips or repeats a parse", async () => {
    const first = (ids: Array<string>) => ids[0] as string;
    expect(String(await judgeWith((ids) => [evaluation(first(ids), 5)]))).toContain("did not score every parse");
    expect(String(await judgeWith((ids) => [evaluation(first(ids), 5), evaluation(first(ids), 6)]))).toContain(
      "did not score every parse",
    );
  });

  it("fails on out-of-range scores and HTTP errors", async () => {
    expect(String(await judgeWith((ids) => ids.map((id) => evaluation(id, 11))))).toContain("out of range");
    expect(String(await judgeWith(() => [], 500))).toContain("HTTP 500");
  });
});

describe("unblind", () => {
  it("replaces blind labels with preset labels and leaves unknown ones", () => {
    expect(
      unblind("Matches parse_a; parse_b drops a row; parse_c is unknown.", { parse_a: "reducto_r1", parse_b: "aws_textract" }),
    ).toBe("Matches Reducto r-1; AWS Textract (layout, tables) drops a row; parse_c is unknown.");
  });
});
