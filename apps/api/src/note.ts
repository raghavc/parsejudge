import { PRESETS } from "@parsejudge/core";
import type { Env } from "./env.ts";

/** A page gets a note when its best and worst scores differ by this much, or a parse failed. Matches the report. */
const NOTE_GAP = 3;

const PROMPT =
  "You summarize how document parsers did on one page. You get each parser's place on the page (best, middle or " +
  "worst) and the errors a judge found in its output. Write one plain sentence of at most 25 words that says which " +
  "parser did best, which did worst, and the main error that separates them. Use the parser names as given. Reply " +
  "with the sentence only, on one line.";

const SHORT_NAMES: Record<string, string> = {
  reducto: "Reducto",
  azure_document_intelligence: "Azure",
  aws_textract: "Textract",
  mistral_ocr: "Mistral",
  extend: "Extend",
  llamaparse: "LlamaParse",
  datalab: "Datalab",
  pulse: "Pulse",
  cohere: "Cohere",
};

type Row = { preset_id: string; status: string; error: string | null; score: number | null; errors: string | null };

/** The report's names: the provider alone, plus the mode when the run has two options from one provider. */
const namer = (presetIds: ReadonlyArray<string>) => (presetId: string) => {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (preset === undefined) return presetId;
  const provider = SHORT_NAMES[preset.provider] ?? preset.provider;
  const siblings = presetIds.filter((id) => PRESETS.find((p) => p.id === id)?.provider === preset.provider).length;
  return siblings > 1 ? `${provider} ${preset.mode}` : provider;
};

/** Writes the page note for flagged pages. Throws on a model or HTTP error so the workflow step retries. */
export const writePageNote = async (env: Env, runId: string, pageId: string): Promise<void> => {
  const rows = await env.DB.prepare(
    `SELECT p.preset_id, p.status, p.error, v.score, v.errors FROM parses p
     LEFT JOIN verdicts v USING (run_id, page_id, preset_id) WHERE p.run_id = ? AND p.page_id = ?`,
  )
    .bind(runId, pageId)
    .all<Row>();
  const scores = rows.results.flatMap((r) => (r.status === "succeeded" && r.score !== null ? [r.score] : []));
  const failed = rows.results.some((r) => r.status !== "succeeded");
  if (!failed && (scores.length < 2 || Math.max(...scores) - Math.min(...scores) < NOTE_GAP)) return;
  const top = Math.max(...scores);
  const bottom = Math.min(...scores);
  const label = namer(rows.results.map((r) => r.preset_id));
  const lines = rows.results.map((r) => {
    if (r.status !== "succeeded") return `${label(r.preset_id)}: parse failed (${r.error ?? "no error message"})`;
    const errors = JSON.parse(r.errors ?? "[]") as Array<{ category: string; severity: string; description: string }>;
    const found = errors.map((e) => `${e.severity} ${e.category}: ${e.description}`).join("; ");
    const place = r.score === null ? "not judged" : r.score === top ? "best" : r.score === bottom ? "worst" : "middle";
    return `${label(r.preset_id)}: ${place}. Errors: ${found || "none"}`;
  });
  const response = await fetch(`${env.JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.JUDGE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.SMALL_MODEL,
      max_tokens: 120,
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: lines.join("\n") },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const note = data.choices?.[0]?.message?.content?.trim();
  if (!note || note.includes("\n")) throw new Error(`Unusable page note: ${JSON.stringify(note)}`);
  await env.DB.prepare("INSERT OR REPLACE INTO page_notes (run_id, page_id, note) VALUES (?, ?, ?)")
    .bind(runId, pageId, note)
    .run();
};
