import type { Env } from "./env.ts";
import { openRouterUsage, recordUsage } from "./usage.ts";

const PROMPT =
  "Write a short title (2 to 6 words) for an evaluation run over these documents. Describe what the documents are, " +
  'for example "34 product designer resumes" or "Motion to dismiss". Reply with the title only.';

export const generateTitle = async (env: Env, filenames: ReadonlyArray<string>): Promise<string | null> => {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${env.JUDGE_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.JUDGE_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.SMALL_MODEL,
        max_tokens: 30,
        messages: [
          { role: "system", content: PROMPT },
          { role: "user", content: `${filenames.length} documents:\n${filenames.join("\n")}` },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    recordUsage(env, {
      kind: "title",
      name: env.SMALL_MODEL,
      status: "ok",
      latencyMs: Date.now() - startedAt,
      ...openRouterUsage(data.usage),
    });
    const title = data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "");
    return title && title.length <= 80 ? title : null;
  } catch (error) {
    console.error("Run title generation failed", error);
    return null;
  }
};
