import { useCallback, useEffect, useState } from "react";
import { api, type CellDone, currentUser, type Preset, type Run } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Nav } from "./Nav.tsx";
import { providerName, seconds } from "./names.ts";
import { Report } from "./Report.tsx";

const p50 = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
};

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const runTitle = (run: Run) => {
  if (run.title) return run.title;
  const names = run.documents.map((d) => d.filename.replace(/\.[^.]+$/, ""));
  if (names.length <= 2) return names.join(" and ");
  return `${names.length} documents`;
};

const Bar = ({ value, height = 2 }: { readonly value: number; readonly height?: number }) => (
  <div style={{ background: "var(--rule)", display: "flex", flexGrow: 1, height }}>
    <div
      style={{
        background: "var(--ink)",
        height,
        width: "100%",
        transform: `scaleX(${value})`,
        transformOrigin: "left",
        transition: "transform 300ms var(--ease-out)",
      }}
    />
  </div>
);

const Progress = ({
  run,
  presets,
  onDone,
}: {
  readonly run: Run;
  readonly presets: ReadonlyArray<Preset>;
  readonly onDone: () => void;
}) => {
  const [cells, setCells] = useState<ReadonlyMap<string, CellDone>>(new Map());
  const [judged, setJudged] = useState(0);
  const [startedPresets, setStartedPresets] = useState<ReadonlySet<string>>(new Set());
  const [now, setNow] = useState(Date.now());
  const pages = run.documents.reduce((n, d) => n + d.pages.length, 0);

  useEffect(() => {
    const key = (c: CellDone) => `${c.presetId}:${c.pageId}`;
    return api.events(run.id, (event) => {
      if (event.type === "progress") {
        setCells(new Map(event.cells.map((c) => [key(c), c])));
        setStartedPresets(new Set(event.started ?? []));
        setJudged(event.done);
      } else if (event.type === "parse_started") setStartedPresets((s) => new Set(s).add(event.presetId));
      else if (event.type === "parse_done") setCells((m) => new Map(m).set(key(event), event));
      else if (event.type === "page_done") setJudged(event.done);
      else onDone();
    });
  }, [run.id, onDone]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const all = [...cells.values()];
  const total = pages * run.presetIds.length;
  const judgeDone = pages > 0 && judged === pages;
  const progress = total === 0 ? 0 : (all.length + judged) / (total + pages);
  const share = `${location.host}/r/${run.shareId}`;
  const user = currentUser();
  const started = new Date(run.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const head = { color: "var(--muted)" } as const;

  return (
    <div className="stagger">
      <section
        className="head"
        style={{ alignItems: "end", display: "flex", justifyContent: "space-between", padding: "72px var(--gutter) 40px" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <div style={{ background: "var(--accent)", borderRadius: 4, height: 8, width: 8 }} />
            <div className="eyebrow" style={{ color: "var(--accent)", fontSize: 13 }}>
              {pages === 0 ? "Preparing pages" : judged === pages ? "Summarizing" : "Running"} · {elapsed(now - run.createdAt)}{" "}
              elapsed
            </div>
          </div>
          <div style={{ fontSize: "clamp(32px, 4.5vw, 48px)", fontWeight: 300, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            {runTitle(run)}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 15 }}>
            {run.documents.length} documents · {pages} pages · {run.presetIds.length} providers · started {started}
          </div>
        </div>
        <div style={{ alignItems: "end", display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: "clamp(40px, 6vw, 64px)", fontWeight: 300, letterSpacing: "-0.04em", lineHeight: 1 }}>
            {Math.floor(progress * 100)}%
          </div>
          <div style={{ color: "var(--muted)", fontSize: 14 }}>
            {all.length} of {total} parses · {judged} of {pages} pages judged
          </div>
        </div>
      </section>
      <div style={{ display: "flex", padding: "0 var(--gutter)" }}>
        <Bar value={progress} />
      </div>
      <section className="scroll-x" style={{ display: "flex", flexDirection: "column", padding: "48px var(--gutter) 0" }}>
        <div className="eyebrow" style={{ borderBottom: "1px solid var(--line)", display: "flex", gap: 24, paddingBottom: 12 }}>
          <div style={{ width: 260 }}>Provider</div>
          <div style={{ flexGrow: 1 }}>Pages</div>
          <div style={{ textAlign: "right", width: 100 }}>Done</div>
          <div style={{ textAlign: "right", width: 120 }}>p50 latency</div>
          <div style={{ textAlign: "right", width: 140 }}>Status</div>
        </div>
        {run.presetIds.map((id) => {
          const preset = presets.find((p) => p.id === id);
          const mine = all.filter((c) => c.presetId === id);
          const failed = mine.filter((c) => !c.ok).length;
          const latency = p50(mine.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs])));
          const finished = pages > 0 && mine.length === pages;
          const status = finished ? "Done" : mine.length === 0 && !startedPresets.has(id) ? "Queued" : "Parsing";
          return (
            <div key={id} className="row" style={{ fontSize: 14, gap: 24, padding: "20px 0" }}>
              <div style={{ fontSize: 15, width: 260 }}>
                {preset ? providerName(preset.provider) : id}
                {preset && <span style={head}> · {preset.mode}</span>}
              </div>
              <Bar value={pages === 0 ? 0 : mine.length / pages} />
              <div style={{ textAlign: "right", width: 100 }}>
                {mine.length} / {pages}
              </div>
              <div style={{ ...head, textAlign: "right", width: 120 }}>{seconds(latency)}</div>
              <div style={{ color: finished ? "var(--ink)" : "var(--muted)", textAlign: "right", width: 140 }}>
                {status}
                {failed > 0 && <span style={{ color: "var(--bad)" }}> · {failed} failed</span>}
              </div>
            </div>
          );
        })}
        <div className="row" style={{ fontSize: 14, gap: 24, padding: "20px 0" }}>
          <div style={{ fontSize: 15, width: 260 }}>
            Judge<span style={head}> · {run.judgeModel.replace(/^.*\//, "")}</span>
          </div>
          <Bar value={pages === 0 ? 0 : judged / pages} />
          <div style={{ textAlign: "right", width: 100 }}>
            {judged} / {pages}
          </div>
          <div style={{ ...head, textAlign: "right", width: 120 }}>–</div>
          <div style={{ color: judgeDone ? "var(--ink)" : "var(--muted)", textAlign: "right", width: 140 }}>
            {judgeDone ? "Done" : judged > 0 ? "Judging" : "Waiting"}
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            justifyContent: "space-between",
            padding: "40px 0 72px",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: 14 }}>
            You can close this tab.
            {user ? ` We'll email ${user} when the report is ready.` : " The link below opens the report when it is ready."}
          </div>
          <div style={{ alignItems: "center", display: "flex", gap: 16, fontSize: 14 }}>
            {share}
            <CopyButton text={`${location.protocol}//${share}`} label="Copy link" />
          </div>
        </div>
      </section>
    </div>
  );
};

export const RunPage = ({ shareId }: { readonly shareId: string }) => {
  const [run, setRun] = useState<Run | null>(null);
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .shared(shareId)
      .then(setRun, (e: unknown) =>
        setError(String(e).includes("404") ? "This run was deleted or the link is wrong." : String(e)),
      );
  }, [shareId]);

  useEffect(() => {
    load();
    api.presets().then(setPresets, () => {});
  }, [load]);

  const finished = run !== null && (run.status === "succeeded" || run.status === "failed") && run.summary !== null;
  return (
    <div>
      <Nav user={currentUser()} />
      {error && <div style={{ color: "var(--bad)", padding: "72px var(--gutter)" }}>{error}</div>}
      {run?.status === "failed" && run.summary === null && (
        <div style={{ color: "var(--bad)", padding: "72px var(--gutter)" }}>This run failed: {run.error ?? "unknown error"}</div>
      )}
      {run &&
        run.status !== "failed" &&
        (finished ? (
          <Report run={run} presets={presets} title={runTitle(run)} />
        ) : (
          <Progress run={run} presets={presets} onDone={load} />
        ))}
    </div>
  );
};
