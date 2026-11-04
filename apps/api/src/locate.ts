import { decodeJson } from "@parsejudge/core";
import { Effect } from "effect";
import { marked } from "marked";
import type { Env } from "./env.ts";
import { markdownKey } from "./keys.ts";
import { complete, openRouterUsage, recordUsage } from "./usage.ts";

/** One place an error appears: `text` occurs in the output's visible text, and `occurrence` picks which match (1-based). */
export interface Quote {
  readonly text: string;
  readonly occurrence: number;
}

interface Flag {
  readonly category: string;
  readonly severity: string;
  readonly description: string;
}

const MAX_QUOTES = 6;
const MAX_LENGTH = 120;
const ROUNDS = 4;

const PROMPT = `You find where errors are in a document parser's output. You get the output and a numbered list of errors that a judge found in it.

For each error, give up to ${MAX_QUOTES} excerpts that show where the error is in the output. Rules for each excerpt:
- Copy it exactly, character for character, from the output's visible text. It must be one contiguous span on one line, at most ${MAX_LENGTH} characters.
- It must not contain Markdown or HTML syntax (no * _ | # < > or backticks), so keep it inside one table cell, heading or run of plain text.
- Pick the span the error is about, for example the misread word with a few words around it, or the start of a duplicated sentence.
- If the same text appears more than once in the output, set "occurrence" to say which one (1 is the first in the output). Otherwise set it to 1.
If an error is about content that is missing from the output, give no excerpts for it.

Reply with JSON only, in this form: {"errors": [{"error": 1, "quotes": [{"text": "...", "occurrence": 1}]}]}`;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: "\u00a0" };

/**
 * The output's text as the viewer renders it: Markdown rendered the same way, every tag turned into a break so an
 * excerpt cannot span two elements, and common entities decoded. Excerpts are matched against this.
 */
export const visibleText = (markdown: string): string =>
  marked
    .parse(markdown, { async: false })
    .replace(/<[^>]*>/g, "\u0000")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "");

const occurrences = (text: string, quote: string): Array<number> => {
  const at: Array<number> = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) at.push(i);
  return at;
};

/** Checks one error's excerpts. Returns the problems to send back to the model; empty means every excerpt is usable. */
export const checkQuotes = (text: string, quotes: ReadonlyArray<Quote>): Array<string> => {
  const problems: Array<string> = [];
  if (quotes.length > MAX_QUOTES) problems.push(`give at most ${MAX_QUOTES} excerpts`);
  for (const quote of quotes) {
    const q = quote.text;
    const label = JSON.stringify(q);
    if (q.trim() === "") problems.push("an excerpt is empty");
    else if (q.length > MAX_LENGTH) problems.push(`${label} is longer than ${MAX_LENGTH} characters`);
    else if (/[\n*_|#<>`]/.test(q)) problems.push(`${label} contains a line break or Markdown/HTML syntax`);
    else {
      const at = occurrences(text, q);
      if (at.length === 0)
        problems.push(`${label} is not in the output's text exactly as written, or it crosses a link or formatting`);
      else if (!Number.isInteger(quote.occurrence) || quote.occurrence < 1 || quote.occurrence > at.length) {
        const places = at.map((i, n) => `${n + 1}: "…${text.slice(Math.max(0, i - 40), i + q.length + 40)}…"`);
        problems.push(
          `${label} appears ${at.length} times, so occurrence must be 1 to ${at.length}. Pick the right one, or lengthen the excerpt:\n${places.join("\n")}`,
        );
      }
    }
  }
  return problems;
};

/** The model's excerpts by error number, or None when the reply is not valid JSON. */
const parseReply = (content: string) =>
  decodeJson(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1)).pipe(
    Effect.map((decoded) => {
      const data = decoded as { errors?: Array<{ error?: number; quotes?: Array<Partial<Quote> | string> }> };
      const found = new Map<number, Array<Quote>>();
  for (const item of data.errors ?? []) {
    if (typeof item.error !== "number") continue;
    found.set(
      item.error,
      (item.quotes ?? []).map((q) =>
        typeof q === "string"
          ? { text: q, occurrence: 1 }
          : { text: String(q.text ?? ""), occurrence: Number(q.occurrence ?? 1) },
      ),
    );
  }
      return found;
    }),
    Effect.option,
  );

type Message = { role: "system" | "user" | "assistant"; content: string };

type Where = { readonly runId?: string; readonly pageId?: string };

const ask = (env: Env, messages: ReadonlyArray<Message>, where: Where) => {
  const startedAt = Date.now();
  return complete(env, { model: env.SMALL_MODEL, max_tokens: 2000, messages }, "60 seconds").pipe(
    Effect.tap(({ usage }) =>
      recordUsage(env, {
        kind: "locate",
        name: env.SMALL_MODEL,
        ...where,
        status: "ok",
        latencyMs: Date.now() - startedAt,
        ...openRouterUsage(usage),
      }),
    ),
    Effect.map(({ content }) => content),
  );
};

/**
 * Finds the excerpts of the output each judge error is about. The model's excerpts are checked against the output, and
 * the problems go back to it until every error has excerpts that match one place, or the rounds run out.
 */
export const locate = Effect.fn("locate")(function* (env: Env, markdown: string, flags: ReadonlyArray<Flag>, where: Where = {}) {
  const text = visibleText(markdown);
  const located: Array<Array<Quote> | undefined> = flags.map(() => undefined);
  const list = flags.map((f, i) => `${i + 1}. ${f.severity} ${f.category}: ${f.description}`).join("\n");
  const messages: Array<Message> = [
    { role: "system", content: PROMPT },
    { role: "user", content: `Output:\n<output>\n${markdown}\n</output>\n\nErrors:\n${list}` },
  ];
  let last = new Map<number, Array<Quote>>();
  for (let round = 0; round < ROUNDS && located.includes(undefined); round++) {
    const reply = yield* ask(env, messages, where);
    messages.push({ role: "assistant", content: reply });
    const parsed = yield* parseReply(reply);
    if (parsed._tag === "None") {
      messages.push({ role: "user", content: "That was not valid JSON. Reply with JSON only, in the form given." });
      continue;
    }
    last = parsed.value;
    const feedback: Array<string> = [];
    for (const [i, done] of located.entries()) {
      if (done !== undefined) continue;
      const quotes = last.get(i + 1);
      const problems = quotes === undefined ? ["missing from your reply"] : checkQuotes(text, quotes);
      if (problems.length === 0) located[i] = quotes;
      else feedback.push(`Error ${i + 1}:\n- ${problems.join("\n- ")}`);
    }
    if (feedback.length > 0) {
      messages.push({
        role: "user",
        content: `Fix these and reply with JSON for only these errors:\n\n${feedback.join("\n\n")}`,
      });
    }
  }
  return located.map((quotes, i) => quotes ?? (last.get(i + 1) ?? []).filter((q) => checkQuotes(text, [q]).length === 0));
});

/** Locates the errors of one judged parse and stores them. Fails on a model, HTTP or OpenRouter error so the workflow step retries. */
export const writeLocations = Effect.fn("writeLocations")(function* (env: Env, runId: string, pageId: string, presetId: string) {
  const row = yield* Effect.promise(() =>
    env.DB.prepare("SELECT errors FROM verdicts WHERE run_id = ? AND page_id = ? AND preset_id = ?")
      .bind(runId, pageId, presetId)
      .first<{ errors: string }>(),
  );
  const flags = (yield* decodeJson(row?.errors ?? "[]")) as Array<Flag>;
  if (flags.length === 0) return;
  const object = yield* Effect.promise(() => env.BLOBS.get(markdownKey(runId, pageId, presetId)));
  if (object === null) return;
  const markdown = yield* Effect.promise(() => object.text());
  const quotes = yield* locate(env, markdown, flags, { runId, pageId });
  yield* Effect.promise(() =>
    env.DB.prepare("INSERT OR REPLACE INTO page_locations (run_id, page_id, preset_id, quotes) VALUES (?, ?, ?, ?)")
      .bind(runId, pageId, presetId, JSON.stringify(quotes))
      .run(),
  );
});
