import { Effect } from "effect";
import type { Env } from "./env.ts";
import { complete, openRouterUsage, recordUsage } from "./usage.ts";

const PROMPT =
  "Write a short title (2 to 6 words) for an evaluation run over these documents. Describe what the documents are, " +
  'for example "34 product designer resumes" or "Motion to dismiss". Reply with the title only.';

export const generateTitle = Effect.fn("generateTitle")(function* (env: Env, filenames: ReadonlyArray<string>) {
  const startedAt = Date.now();
  return yield* complete(
    env,
    {
      model: env.SMALL_MODEL,
      max_tokens: 30,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: `${filenames.length} documents:\n${filenames.join("\n")}` },
      ],
    },
    "5 seconds",
  ).pipe(
    Effect.tap(({ usage }) =>
      recordUsage(env, { kind: "title", name: env.SMALL_MODEL, status: "ok", latencyMs: Date.now() - startedAt, ...openRouterUsage(usage) }),
    ),
    Effect.map(({ content }) => {
      const title = content.trim().replace(/^["']|["']$/g, "");
      return title && title.length <= 80 ? title : null;
    }),
    Effect.catchCause((cause) => Effect.logError("Run title generation failed", cause).pipe(Effect.as(null))),
  );
});
