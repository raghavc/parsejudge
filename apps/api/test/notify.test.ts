import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { emailRunDone } from "../src/notify.ts";

const env = (row: Record<string, unknown> | null) => {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const parses = [
    { page_id: "p1", status: "succeeded" },
    { page_id: "p1", status: "succeeded" },
    { page_id: "p2", status: "succeeded" },
    { page_id: "p2", status: "failed" },
  ];
  const tableError = JSON.stringify([{ category: "table_structure", severity: "high", description: "merged cells" }]);
  const verdicts = [
    { page_id: "p1", score: 10, errors: "[]" },
    { page_id: "p1", score: 5, errors: tableError },
    { page_id: "p2", score: 9, errors: "[]" },
  ];
  const value = {
    PUBLIC_URL: "https://parsejudge.com",
    EMAIL_FROM: "noreply@parsejudge.com",
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => (sql.includes("COUNT(*)") ? { documents: 2, pages: 2 } : row),
          all: async () => ({ results: sql.includes("FROM parses") ? parses : verdicts }),
        }),
      }),
    },
    EMAIL: { send: async (m: (typeof sent)[number]) => void sent.push(m) },
  } as unknown as Env;
  return { value, sent };
};

const base = {
  title: "Q3 <invoices>",
  status: "succeeded",
  share_id: "abc123",
  summary: JSON.stringify({
    presets: [
      { presetId: "aws_textract", label: "Textract", meanScore: 7.5, highSeverityRate: 0.5, failedPages: 1 },
      { presetId: "reducto_r1", label: "r-1", meanScore: 9.5, highSeverityRate: 0, failedPages: 0 },
    ],
  }),
  error: null,
  visibility: "link",
  created_at: 0,
  completed_at: 161_000,
  email: "a@b.com",
  notify_on_done: 1,
};

describe("emailRunDone", () => {
  it("sends the report-ready email from the design, best provider first", async () => {
    const { value, sent } = env(base);
    await emailRunDone(value, "run");
    expect(sent).toHaveLength(1);
    const mail = sent[0];
    expect(mail?.subject).toBe("Your report is ready: Q3 <invoices>");
    expect(mail?.text.indexOf("r-1")).toBeLessThan(mail?.text.indexOf("Textract") ?? 0);
    expect(mail?.text).toContain("2 documents · 2 pages · finished in 2 min 41 s");
    expect(mail?.text).toContain("disagreed by 3 points or more on 1 page, mostly on tables. One page failed for");
    expect(mail?.text).toContain("See the 2 flagged pages: https://parsejudge.com/r/abc123/p/p1");
    expect(mail?.text).toContain("Anyone with the link can view this report: parsejudge.com/r/abc123.");
    expect(mail?.html).toContain("Q3 &#60;invoices&#62;");
    expect(mail?.html).toContain("claude mcp add --transport http parsejudge https://parsejudge.com/mcp");
  });

  it("says the run failed", async () => {
    const { value, sent } = env({ ...base, status: "failed", summary: null, error: "Stopped" });
    await emailRunDone(value, "run");
    expect(sent[0]?.subject).toBe("Your run failed: Q3 <invoices>");
    expect(sent[0]?.text).toContain("The run failed: Stopped");
  });

  it("says a private report is only for the owner", async () => {
    const { value, sent } = env({ ...base, visibility: "private" });
    await emailRunDone(value, "run");
    expect(sent[0]?.text).toContain("Only you can open this report");
  });

  it("sends nothing when the owner turned emails off", async () => {
    const { value, sent } = env({ ...base, notify_on_done: 0 });
    await emailRunDone(value, "run");
    expect(sent).toHaveLength(0);
  });
});
