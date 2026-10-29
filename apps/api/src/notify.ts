import { findPreset } from "@parsejudge/core";
import type { Env } from "./env.ts";

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

interface PresetLine {
  readonly label: string;
  readonly meanScore: number | null;
}

/** Emails the run's owner that the report is ready (or that the run failed), unless they turned it off. */
export const emailRunDone = async (env: Env, runId: string): Promise<void> => {
  const row = await env.DB.prepare(
    `SELECT r.title, r.status, r.share_id, r.summary, r.error, u.email, u.notify_on_done
     FROM runs r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
  )
    .bind(runId)
    .first<{
      title: string | null;
      status: string;
      share_id: string;
      summary: string | null;
      error: string | null;
      email: string;
      notify_on_done: number;
    }>();
  if (row === null || row.notify_on_done !== 1 || !row.email.includes("@") || row.email.endsWith(".invalid")) return;
  const title = row.title ?? "Untitled run";
  const url = `${env.PUBLIC_URL}/r/${row.share_id}`;
  const presets = ((row.summary === null ? null : JSON.parse(row.summary)) as { presets?: Array<PresetLine & { presetId: string }> } | null)
    ?.presets?.map((p) => ({ label: findPreset(p.presetId)?.label ?? p.label, meanScore: p.meanScore }))
    .sort((a, b) => (b.meanScore ?? -1) - (a.meanScore ?? -1)) ?? [];
  const ok = row.status === "succeeded";
  const lines = presets.map((p) => `${p.label}: ${p.meanScore === null ? "no score" : p.meanScore.toFixed(1)}`);
  const text = ok
    ? `Your ParseJudge report "${title}" is ready.\n\nMean score, 1 to 10:\n${lines.join("\n")}\n\nOpen the report: ${url}\n`
    : `Your ParseJudge run "${title}" failed: ${row.error ?? "unknown error"}\n\n${url}\n`;
  const rows = presets
    .map(
      (p) =>
        `<tr><td style="padding:6px 16px 6px 0">${escape(p.label)}</td><td style="padding:6px 0;text-align:right">${
          p.meanScore === null ? "–" : p.meanScore.toFixed(1)
        }</td></tr>`,
    )
    .join("");
  const html = `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;color:#111;max-width:520px">
<p>${ok ? `Your report <b>${escape(title)}</b> is ready.` : `Your run <b>${escape(title)}</b> failed: ${escape(row.error ?? "unknown error")}`}</p>
${ok && rows !== "" ? `<table style="border-collapse:collapse;font-size:14px"><tr><td style="color:#666;padding:0 16px 6px 0">Provider</td><td style="color:#666;padding:0 0 6px">Mean score</td></tr>${rows}</table>` : ""}
<p><a href="${escape(url)}" style="color:#111">Open the report</a></p>
<p style="color:#666;font-size:13px">You can turn these emails off in your ParseJudge account settings.</p></div>`;
  await env.EMAIL.send({
    from: { name: "ParseJudge", email: env.EMAIL_FROM },
    to: row.email,
    subject: ok ? `Report ready: ${title}` : `Run failed: ${title}`,
    text,
    html,
  });
};
