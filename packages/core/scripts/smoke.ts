/** Live smoke test: runs each preset on one public page. Usage: tsx scripts/smoke.ts <pdfUrl> <pngUrl> [presetId...] */
import { readFileSync } from "node:fs";
import { Effect, Option } from "effect";
import { FetchHttpClient } from "effect/http";
import { PRESETS, PROVIDERS } from "../src/index.ts";

const [pdfUrl = "", imageUrl = "", ...only] = process.argv.slice(2);
const credentials = Object.fromEntries(
  readFileSync(new URL("../../../apps/api/.dev.vars", import.meta.url), "utf8")
    .split("\n")
    .flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "")]] : [])),
);
const page = {
  pdfUrl,
  imageUrl,
  pdf: Effect.promise(async () => new Uint8Array(await (await fetch(pdfUrl)).arrayBuffer())),
};

const run = Effect.fn("smoke")(function* (presetId: string) {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const adapter = PROVIDERS[preset.provider];
  const started = Date.now();
  let submission = yield* adapter.submit(page, preset.config, credentials);
  while (submission._tag === "Pending") {
    yield* Effect.sleep("2 seconds");
    const polled = yield* adapter.poll!(submission.job, credentials);
    if (Option.isSome(polled)) submission = { _tag: "Done", output: polled.value };
  }
  const { markdown, reportedCost } = submission.output;
  return `${presetId}: ${Date.now() - started}ms ${markdown.length} chars cost=${JSON.stringify(reportedCost)} | ${markdown.slice(0, 80).replace(/\n/g, " ")}`;
});

const ids = only.length > 0 ? only : PRESETS.map((p) => p.id);
const results = await Effect.runPromise(
  Effect.forEach(ids, (id) => run(id).pipe(Effect.catch((e) => Effect.succeed(`${id}: FAILED ${JSON.stringify(e)}`))), {
    concurrency: "unbounded",
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
console.log(results.join("\n"));
