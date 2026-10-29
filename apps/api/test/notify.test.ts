import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { emailRunDone } from "../src/notify.ts";

const env = (row: Record<string, unknown> | null) => {
  const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const value = {
    PUBLIC_URL: "https://parsejudge.com",
    EMAIL_FROM: "noreply@parsejudge.com",
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
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
      { presetId: "aws_textract", label: "Textract", meanScore: 8.4 },
      { presetId: "reducto_r1", label: "r-1", meanScore: 9.8 },
    ],
  }),
  error: null,
  email: "a@b.com",
  notify_on_done: 1,
};

describe("emailRunDone", () => {
  it("sends scores best first with the report link, escaping the title in HTML", async () => {
    const { value, sent } = env(base);
    await emailRunDone(value, "run");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Report ready: Q3 <invoices>");
    expect(sent[0]?.text.indexOf("r-1")).toBeLessThan(sent[0]?.text.indexOf("Textract") ?? 0);
    expect(sent[0]?.text).toContain("https://parsejudge.com/r/abc123");
    expect(sent[0]?.html).toContain("Q3 &#60;invoices&#62;");
  });

  it("says the run failed", async () => {
    const { value, sent } = env({ ...base, status: "failed", summary: null, error: "Stopped" });
    await emailRunDone(value, "run");
    expect(sent[0]?.subject).toBe("Run failed: Q3 <invoices>");
  });

  it("sends nothing when the owner turned emails off", async () => {
    const { value, sent } = env({ ...base, notify_on_done: 0 });
    await emailRunDone(value, "run");
    expect(sent).toHaveLength(0);
  });
});
