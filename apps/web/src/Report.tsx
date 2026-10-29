import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { api, type PageDetail, type Preset, type PresetSummary, type Run } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { DeleteRun } from "./DeleteRun.tsx";
import { perThousand, providerName, seconds, shortName } from "./names.ts";
import { navigate } from "./router.ts";
import { ShareDialog } from "./Share.tsx";

const h2: CSSProperties = { fontSize: 20, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: "24px" };
const note: CSSProperties = { color: "var(--muted)", fontSize: 14, lineHeight: "22px" };
const cols = { rank: 32, provider: 300, high: 170, price: 110, latency: 110, failed: 80 } as const;

/** Multiples of a 1/2/5 × 10^k step that fall inside [lo, hi]. */
const ticks = (lo: number, hi: number, count: number) => {
  const raw = (hi - lo) / count;
  const base = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * base).find((s) => s >= raw) ?? raw;
  const out: Array<number> = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(t);
  return out;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

interface Point {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly accent: boolean;
}

const median = (xs: ReadonlyArray<number>) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

const logTicks = (lo: number, hi: number) => {
  const out: Array<number> = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo && v <= hi) out.push(v);
    }
  return out;
};

/**
 * Score against a log-scaled cost-like x axis, where lower x is better. The shaded quadrant is better than the
 * median on both axes; the dotted line is the Pareto frontier (best score at or below each x).
 */
const Scatter = ({
  points,
  xTick,
  yMin,
  yMax,
}: {
  readonly points: ReadonlyArray<Point>;
  readonly xTick: (x: number) => string;
  readonly yMin: number;
  readonly yMax: number;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = box.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const W = Math.max(280, width);
  const H = W < 480 ? 240 : 300;
  const L = 32;
  const R = 16;
  const T = 12;
  const B = 28;
  const xs = points.map((p) => p.x);
  const mx = median(xs);
  const k = Math.max(...xs.map((x) => Math.max(x / mx, mx / x))) * 1.8;
  const lo = mx / k;
  const hi = mx * k;
  const sx = (x: number) => L + ((Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (W - L - R);
  const sy = (y: number) => T + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - B - T);
  const frontier: Array<Point> = [];
  for (const p of [...points].sort((a, b) => a.x - b.x || b.y - a.y))
    if (p.y > (frontier.at(-1)?.y ?? Number.NEGATIVE_INFINITY)) frontier.push(p);
  const onFrontier = new Set(frontier.map((p) => p.id));
  const qx = sx(mx);
  const qy = sy(median(points.map((p) => p.y)));
  const yTicks = ticks(yMin, yMax, 3);
  const labels = new Map<string, { readonly x: number; readonly y: number; readonly right: boolean }>();
  const placed: Array<{ readonly x0: number; readonly x1: number; readonly y: number }> = [];
  for (const p of [...points].sort((a, b) => b.y - a.y)) {
    const right = sx(p.x) > W - 150;
    const x = sx(p.x) + (right ? -9 : 9);
    const x0 = right ? x - p.label.length * 6.6 : x;
    const x1 = x0 + p.label.length * 6.6;
    let y = sy(p.y) - 8;
    for (const q of placed) if (x0 < q.x1 && q.x0 < x1 && Math.abs(y - q.y) < 15) y = q.y + 15;
    placed.push({ x0, x1, y });
    labels.set(p.id, { x, y, right });
  }
  return (
    <div ref={box}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="chart"
      >
        {points.length > 1 && (
          <>
            <rect x={L} y={T} width={Math.max(0, qx - L)} height={Math.max(0, qy - T)} fill="var(--good)" opacity={0.07} />
            <text x={L + 8} y={Math.max(T + 16, qy - 8)} fontSize={11} fill="var(--good)" letterSpacing="0.04em">
              MOST ATTRACTIVE
            </text>
          </>
        )}
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="var(--line)" />
        {yTicks.map((y) => (
          <text key={y} x={L - 10} y={sy(y) + 4} fontSize={11} fill="var(--faint)" textAnchor="end">
            {Math.round(y)}
          </text>
        ))}
        {logTicks(lo, hi).map((x) => (
          <text key={x} x={sx(x)} y={H - 8} fontSize={11} fill="var(--faint)" textAnchor="middle">
            {xTick(x)}
          </text>
        ))}
        {frontier.length > 1 && (
          <path
            d={frontier.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x)},${sy(p.y)}`).join(" ")}
            fill="none"
            stroke="var(--ink)"
            strokeDasharray="1 4"
            strokeLinecap="round"
            strokeWidth={1.5}
          />
        )}
        {points.map((p) => {
          const label = labels.get(p.id);
          return (
            <g key={p.id}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r={4.5} fill={onFrontier.has(p.id) ? "var(--accent)" : "var(--ink)"} />
              {label && (
                <text x={label.x} y={label.y} fontSize={12} fill="var(--ink)" textAnchor={label.right ? "end" : "start"}>
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

const Dots = ({ scores, names }: { readonly scores: ReadonlyArray<number | null>; readonly names: ReadonlyArray<string> }) => {
  const ok = scores.filter((s): s is number => s !== null);
  const best = Math.max(...ok);
  const worst = Math.min(...ok);
  return (
    <div style={{ borderTop: "1px solid var(--rule)", height: 0, margin: "14px 0", position: "relative" }}>
      {scores.map((s, i) => {
        const failed = s === null;
        const left = `${((failed ? 1 : s) - 1) * (100 / 9)}%`;
        const fill = failed ? "#fff" : s === best ? "var(--accent)" : s === worst && best !== worst ? "#fff" : "var(--ink)";
        const border = failed ? "var(--bad)" : s === best ? "var(--accent)" : "var(--ink)";
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: scores have no identity beyond their slot
            key={i}
            title={`${names[i] ?? ""}: ${failed ? "failed" : `${s} / 10`}`}
            style={{
              background: fill,
              border: `1px solid ${border}`,
              borderRadius: failed ? 1 : 4,
              height: 8,
              left,
              position: "absolute",
              top: -4,
              transform: failed ? "rotate(45deg)" : undefined,
              width: 8,
            }}
          />
        );
      })}
    </div>
  );
};

type Filter =
  | { readonly kind: "gap" }
  | { readonly kind: "failed" }
  | { readonly kind: "h2h"; readonly row: string; readonly col: string; readonly outcome: "win" | "tie" | "loss" };

export const Report = ({
  run,
  presets,
  title,
}: {
  readonly run: Run;
  readonly presets: ReadonlyArray<Preset>;
  readonly title: string;
}) => {
  const summary = run.summary;
  const byId = useMemo(() => new Map(presets.map((p) => [p.id, p])), [presets]);
  const ranked = useMemo(
    () => [...(summary?.presets ?? [])].sort((a, b) => (b.meanScore ?? -1) - (a.meanScore ?? -1)),
    [summary],
  );
  const name = (id: string) => {
    const preset = byId.get(id);
    if (!preset) return id;
    const siblings = run.presetIds.filter((other) => byId.get(other)?.provider === preset.provider).length;
    return siblings > 1 ? `${shortName(preset.provider)} ${preset.mode}` : shortName(preset.provider);
  };

  const pages = run.documents.flatMap((d) =>
    d.pages.map((p) => ({ ...p, label: `${d.filename.replace(/\.[^.]+$/, "")} · p. ${p.index + 1}` })),
  );
  const scoreOf = (pageId: string, presetId: string) => {
    const cell = run.scores.find((s) => s.pageId === pageId && s.presetId === presetId);
    return cell?.status === "succeeded" ? (cell.score ?? null) : null;
  };
  const pageStats = pages.map((page) => {
    const cells = run.presetIds.map((id) => run.scores.find((s) => s.pageId === page.id && s.presetId === id));
    const scores = cells.map((c) => (c?.status === "succeeded" ? (c.score ?? null) : null));
    const ok = scores.filter((s): s is number => s !== null);
    const failed = scores.length - ok.length;
    return { page, scores, failed, gap: ok.length > 1 ? Math.max(...ok) - Math.min(...ok) : 0 };
  });
  const disagreements = pageStats.filter((d) => d.gap >= 3 || d.failed > 0);
  const failedCount = disagreements.filter((d) => d.failed > 0).length;
  const [filter, setFilter] = useState<Filter>({ kind: "gap" });
  const versus = (d: (typeof pageStats)[number], f: Extract<Filter, { kind: "h2h" }>) => {
    const a = scoreOf(d.page.id, f.row);
    const b = scoreOf(d.page.id, f.col);
    if (a === null || b === null) return null;
    const outcome = a > b ? "win" : a === b ? "tie" : "loss";
    return outcome === f.outcome ? Math.abs(a - b) : null;
  };
  const matching =
    filter.kind === "h2h"
      ? pageStats.filter((d) => versus(d, filter) !== null).sort((a, b) => (versus(b, filter) ?? 0) - (versus(a, filter) ?? 0))
      : filter.kind === "failed"
        ? disagreements.filter((d) => d.failed > 0).sort((a, b) => b.failed - a.failed)
        : [...disagreements].sort((a, b) => b.gap - a.gap);
  const shown = matching.slice(0, 8);
  const pick = (row: string, col: string, outcome: "win" | "tie" | "loss") => {
    setFilter({ kind: "h2h", row, col, outcome });
    document.getElementById("pages")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const filterLabel = (f: Extract<Filter, { kind: "h2h" }>) =>
    `${name(f.row)} ${f.outcome === "win" ? "beat" : f.outcome === "tie" ? "tied" : "lost to"} ${name(f.col)} · ${matching.length}`;

  const [details, setDetails] = useState<ReadonlyMap<string, PageDetail>>(new Map());
  const shownIds = shown.map((d) => d.page.id).join(",");
  useEffect(() => {
    for (const id of shownIds.split(",").filter(Boolean)) {
      api.page(run.id, id).then(
        (detail) => setDetails((m) => new Map(m).set(id, detail)),
        () => {},
      );
    }
  }, [run.id, shownIds]);

  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState({
    shareId: run.shareId,
    visibility: run.visibility,
    shareContent: run.shareContent,
  });
  if (summary === null) return <div style={{ ...note, padding: "72px var(--gutter)" }}>This run failed: {run.error}</div>;

  const scored = ranked.filter(
    (p): p is PresetSummary & { meanScore: number; latencyMsP50: number } => p.meanScore !== null && p.latencyMsP50 !== null,
  );
  const scorePoints = (x: (p: (typeof scored)[number]) => number): ReadonlyArray<Point> =>
    scored.map((p) => ({
      id: p.presetId,
      label: `${name(p.presetId)} · ${p.meanScore.toFixed(1)}`,
      x: x(p),
      y: p.meanScore,
      accent: false,
    }));
  const minScore = Math.max(0, Math.floor(Math.min(10, ...scored.map((p) => p.meanScore)) - 1));
  const pageCount = run.pageCount;
  const contentHidden = !run.owned && !run.shareContent;
  const date = new Date(run.createdAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  const mcp = `claude mcp add --transport http parsejudge ${location.origin}/mcp`;
  const h2h = (a: string, b: string) => summary.headToHead.find((h) => h.presetId === a && h.opponentId === b);

  return (
    <div className="stagger">
      <section
        className="head"
        style={{ alignItems: "end", display: "flex", justifyContent: "space-between", padding: "72px var(--gutter) 56px" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="eyebrow" style={{ fontSize: 13 }}>
            Evaluation report · {date}
          </div>
          <div
            style={{
              fontSize: "clamp(36px, 5vw, 56px)",
              fontWeight: 300,
              letterSpacing: "-0.035em",
              lineHeight: 1.1,
              maxWidth: 820,
            }}
          >
            {title}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 15 }}>
            {run.documentCount} documents · {pageCount} pages · {run.presetIds.length} providers ·{" "}
            {pageCount * run.presetIds.length} parses judged blind
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn" style={{ height: 40, padding: "0 16px" }} onClick={() => setSharing(true)}>
            Share
          </button>
          {run.owned && <DeleteRun runId={run.id} dataDeleted={run.dataDeletedAt !== null} />}
        </div>
      </section>

      <section className="results" style={{ display: "flex", flexDirection: "column", padding: "0 var(--gutter) 72px" }}>
        <div
          className="eyebrow results-head"
          style={{
            borderBottom: "1px solid var(--line)",
            borderTop: "1px solid var(--ink)",
            display: "flex",
            gap: 24,
            padding: "12px 0",
          }}
        >
          <div style={{ width: cols.rank }}>#</div>
          <div style={{ width: cols.provider }}>Provider</div>
          <div style={{ flexGrow: 1 }}>Mean score · 1 to 10</div>
          <div style={{ textAlign: "right", width: cols.high }}>High-severity pages</div>
          <div style={{ textAlign: "right", width: cols.price }}>$ / 1k pp</div>
          <div style={{ textAlign: "right", width: cols.latency }}>p50 · p95</div>
          <div style={{ textAlign: "right", width: cols.failed }}>Failed</div>
        </div>
        {ranked.map((p, i) => {
          const preset = byId.get(p.presetId);
          return (
            <div key={p.presetId} className="row result" style={{ fontSize: 14, gap: 24, padding: "22px 0" }}>
              <div style={{ color: "var(--muted)", width: cols.rank }}>{i + 1}</div>
              <div className="result-provider" style={{ display: "flex", flexDirection: "column", gap: 2, width: cols.provider }}>
                <div style={{ fontSize: 16, lineHeight: "20px" }}>{preset ? providerName(preset.provider) : p.label}</div>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  {preset?.mode}
                  {preset && !preset.hosted && " · your key"}
                </div>
              </div>
              <div className="result-score" style={{ alignItems: "center", display: "flex", flexGrow: 1, gap: 20 }}>
                <div style={{ fontSize: 24, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: "30px", width: 48 }}>
                  {p.meanScore === null ? "–" : p.meanScore.toFixed(1)}
                </div>
                <div className="result-bar" style={{ background: "#F2F2F2", display: "flex", flexGrow: 1, height: 4 }}>
                  <div style={{ background: "var(--ink)", height: 4, width: `${((p.meanScore ?? 0) / 10) * 100}%` }} />
                </div>
              </div>
              <div className="result-stats">
                <div data-label="High severity" style={{ textAlign: "right", width: cols.high }}>
                  {p.highSeverityRate === null ? "–" : pct(p.highSeverityRate)}
                </div>
                <div data-label="$/1k pp" style={{ textAlign: "right", width: cols.price }}>
                  {perThousand(p.listPriceUsdPerPage)}
                </div>
                <div data-label="p50 · p95" style={{ textAlign: "right", width: cols.latency }}>
                  {seconds(p.latencyMsP50).replace(" s", "")} · {seconds(p.latencyMsP95)}
                </div>
                <div
                  data-label="Failed"
                  style={{ color: p.failedPages > 0 ? "var(--bad)" : "var(--muted)", textAlign: "right", width: cols.failed }}
                >
                  {p.failedPages}
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section
        style={{
          borderTop: "1px solid var(--line)",
          display: "flex",
          flexWrap: "wrap",
          gap: "48px 80px",
          padding: "56px var(--gutter) 64px",
        }}
      >
        <div style={{ display: "flex", flex: "1 1 420px", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={h2}>Score vs. price</div>
            <div style={{ ...note, fontSize: 13, lineHeight: "16px" }}>
              Mean score against list price per 1k pages, log scale.
            </div>
          </div>
          <Scatter
            points={scorePoints((p) => p.listPriceUsdPerPage * 1000)}
            xTick={(x) => `$${+x.toPrecision(2)}`}
            yMin={minScore}
            yMax={10}
          />
        </div>
        <div style={{ display: "flex", flex: "1 1 420px", flexDirection: "column", gap: 20, minWidth: 0 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={h2}>Score vs. latency</div>
            <div style={{ ...note, fontSize: 13, lineHeight: "16px" }}>Mean score against p50 latency per page, log scale.</div>
          </div>
          <Scatter
            points={scorePoints((p) => p.latencyMsP50)}
            xTick={(x) => `${+(x / 1000).toPrecision(2)} s`}
            yMin={minScore}
            yMax={10}
          />
        </div>
      </section>

      <section
        style={{
          borderTop: "1px solid var(--line)",
          display: "flex",
          flexWrap: "wrap",
          gap: "32px 80px",
          padding: "56px var(--gutter)",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
          <div style={h2}>Head to head</div>
          <div style={note}>
            Pages where the row provider scored higher, the same, or lower than the column provider. {pageCount} pages.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ borderBottom: "1px solid var(--ink)", display: "flex", paddingBottom: 10 }}>
            <div className="h2h-name" style={{ width: 140 }} />
            {ranked.map((c) => (
              <div key={c.presetId} style={{ color: "var(--muted)", flex: "1 0 0", fontSize: 13 }}>
                vs {name(c.presetId)}
              </div>
            ))}
          </div>
          {ranked.map((r) => (
            <div key={r.presetId} className="row" style={{ fontSize: 14, padding: "14px 0" }}>
              <div className="h2h-name" style={{ width: 140 }}>
                {name(r.presetId)}
              </div>
              {ranked.map((c) => {
                const h = h2h(r.presetId, c.presetId);
                return (
                  <div key={c.presetId} style={{ color: h ? "var(--ink)" : "#BDBDBD", flex: "1 0 0", whiteSpace: "nowrap" }}>
                    {h ? (
                      <>
                        <button
                          type="button"
                          className="tally"
                          style={{ color: "var(--good)" }}
                          disabled={contentHidden || h.wins === 0}
                          onClick={() => pick(r.presetId, c.presetId, "win")}
                        >
                          {h.wins}
                        </button>{" "}
                        ·{" "}
                        <button
                          type="button"
                          className="tally"
                          disabled={contentHidden || h.ties === 0}
                          onClick={() => pick(r.presetId, c.presetId, "tie")}
                        >
                          {h.ties}
                        </button>{" "}
                        ·{" "}
                        <button
                          type="button"
                          className="tally"
                          style={{ color: "var(--bad)" }}
                          disabled={contentHidden || h.losses === 0}
                          onClick={() => pick(r.presetId, c.presetId, "loss")}
                        >
                          {h.losses}
                        </button>
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <div style={{ color: "var(--muted)", fontSize: 12, paddingTop: 12 }}>
            <span style={{ color: "var(--good)" }}>Wins</span> · ties · <span style={{ color: "var(--bad)" }}>losses</span> for
            the row provider. Click a number to see those pages.
          </div>
        </div>
      </section>

      <section
        className="mcp"
        style={{
          alignItems: "center",
          background: "#F7F7F7",
          borderRadius: 6,
          display: "flex",
          gap: 40,
          justifyContent: "space-between",
          margin: "0 var(--gutter) 72px",
          padding: "28px 32px",
        }}
      >
        <div className="mcp-intro" style={{ display: "flex", flexDirection: "column", gap: 6, width: 420 }}>
          <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: "22px" }}>
            Ask your agent about your evals
          </div>
          <div style={note}>
            One MCP server for Parse Judge. Sign in once and your agent can browse every run you have access to, including this
            one.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, gap: 10, minWidth: 0 }}>
          <div
            style={{
              alignItems: "center",
              background: "#fff",
              gap: 16,
              border: "1px solid var(--line)",
              borderRadius: 4,
              display: "flex",
              justifyContent: "space-between",
              padding: "12px 16px",
            }}
          >
            <span className="mono" style={{ fontSize: 13, minWidth: 0, overflowX: "auto", whiteSpace: "nowrap" }}>
              {mcp}
            </span>
            <CopyButton text={mcp} label="Copy" className="u" style={{ fontSize: 13 }} />
          </div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Try: "On run {run.shareId}, show me the pages where the providers disagree most and why."
          </div>
        </div>
      </section>

      {run.dataDeletedAt !== null ? (
        <section style={{ ...note, borderTop: "1px solid var(--line)", padding: "40px var(--gutter)" }}>
          The documents for this run were deleted on {new Date(run.dataDeletedAt).toLocaleDateString()}. Scores and charts remain.
        </section>
      ) : contentHidden ? (
        <section style={{ ...note, borderTop: "1px solid var(--line)", padding: "40px var(--gutter)" }}>
          The owner shared the scores only. The documents, page images and parser output are private.
        </section>
      ) : (
        <section
          id="pages"
          style={{
            borderTop: "1px solid var(--line)",
            display: "flex",
            flexDirection: "column",
            gap: 28,
            padding: "56px var(--gutter) 72px",
            scrollMarginTop: 16,
          }}
        >
          <div style={{ alignItems: "end", display: "flex", flexWrap: "wrap", gap: 16, justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={h2}>Where providers disagree</div>
              <div style={note}>
                {filter.kind === "h2h"
                  ? `Pages where ${name(filter.row)} scored ${filter.outcome === "win" ? "higher than" : filter.outcome === "tie" ? "the same as" : "lower than"} ${name(filter.col)}. ${matching.length > shown.length ? `Showing the ${shown.length} with the widest margin.` : ""}`
                  : `${disagreements.length} of ${pageCount} pages have a gap of 3 or more points between the best and worst score, or a failed parse.`}
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {(
                [
                  [{ kind: "gap" }, "Largest gap"],
                  ...(failedCount > 0 ? [[{ kind: "failed" }, `Failed · ${failedCount}`] as const] : []),
                  ...(filter.kind === "h2h" ? [[filter, `${filterLabel(filter)}  ×`] as const] : []),
                ] as ReadonlyArray<readonly [Filter, string]>
              ).map(([key, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setFilter(key.kind === "h2h" ? { kind: "gap" } : key)}
                  style={{
                    background: filter.kind === key.kind ? "var(--ink)" : "#fff",
                    border: `1px solid ${filter.kind === key.kind ? "var(--ink)" : "var(--line)"}`,
                    borderRadius: 16,
                    color: filter.kind === key.kind ? "#fff" : "var(--ink)",
                    fontSize: 13,
                    height: 32,
                    padding: "0 12px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <div style={note}>
              {filter.kind === "gap" ? "Every provider scored within 3 points of the others on every page." : "No pages match."}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
              {shown.map((d) => {
                const detail = details.get(d.page.id);
                const worst = detail?.parses
                  .filter((p) => p.reasoning !== null)
                  .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
                return (
                  <a
                    key={d.page.id}
                    href={`/r/${run.shareId}/p/${d.page.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/r/${run.shareId}/p/${d.page.id}`);
                    }}
                  >
                    <div
                      style={{
                        aspectRatio: "4 / 5",
                        background: "var(--panel)",
                        display: "flex",
                        overflow: "hidden",
                        padding: 16,
                      }}
                    >
                      <img
                        src={d.page.imageUrl}
                        alt={d.page.label}
                        style={{ boxShadow: "0 1px 2px #0001", objectFit: "contain", width: "100%" }}
                      />
                    </div>
                    <div style={{ display: "flex", fontSize: 14, gap: 12, justifyContent: "space-between", marginTop: 14 }}>
                      <span className="clip" title={d.page.label}>
                        {d.page.label}
                      </span>
                      <span style={{ color: d.failed > 0 ? "var(--bad)" : "var(--muted)", flexShrink: 0, fontSize: 13 }}>
                        {d.failed > 0 ? `${d.failed} failed` : `gap ${d.gap}`}
                      </span>
                    </div>
                    <Dots scores={d.scores} names={run.presetIds.map(name)} />
                    <div style={{ ...note, fontSize: 13, lineHeight: "18px" }}>{d.page.note ?? worst?.reasoning}</div>
                  </a>
                );
              })}
            </div>
          )}
          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexWrap: "wrap",
              gap: 16,
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <div style={{ alignItems: "center", color: "var(--muted)", display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
              <span style={{ whiteSpace: "nowrap" }}>
                <span style={{ color: "var(--accent)" }}>●</span> best output
              </span>
              <span style={{ whiteSpace: "nowrap" }}>● in between</span>
              <span style={{ whiteSpace: "nowrap" }}>○ worst output</span>
              {failedCount > 0 && (
                <span style={{ whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--bad)" }}>◇</span> failed
                </span>
              )}
              <span>Each dot is one provider's score on this page, from 1 to 10. Hover a dot to see the provider.</span>
            </div>
            {pages[0] && (
              <button
                type="button"
                style={{ fontSize: 14, whiteSpace: "nowrap" }}
                onClick={() => navigate(`/r/${run.shareId}/p/${pages[0]?.id}`)}
              >
                Browse all {pageCount} pages →
              </button>
            )}
          </div>
        </section>
      )}

      <section
        style={{
          background: "#FAFAFA",
          borderTop: "1px solid var(--line)",
          display: "flex",
          flexWrap: "wrap",
          gap: "24px 80px",
          padding: "48px var(--gutter) 64px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>How this was scored</div>
          <div style={{ ...note, fontSize: 13, lineHeight: "20px" }}>
            Read the{" "}
            <a
              className="u"
              href="/methodology"
              onClick={(e) => {
                e.preventDefault();
                navigate("/methodology");
              }}
            >
              methodology and the judge prompt
            </a>
            , or reproduce this run on your own hardware.
          </div>
        </div>
        {[
          ["Judge", `${run.judgeModel} · ${run.judgeVersion}`],
          ["Rendering", "PDFium · PNG"],
          ["Blinding", "shuffled, names hidden"],
          ["Run", run.shareId],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{k}</div>
            <div className="mono" style={{ fontSize: 13 }}>
              {v}
            </div>
          </div>
        ))}
      </section>
      {sharing && (
        <ShareDialog
          runId={run.id}
          shareId={shared.shareId}
          visibility={shared.visibility}
          shareContent={shared.shareContent}
          owned={run.owned}
          onClose={() => setSharing(false)}
          onChange={(c) => {
            setShared(c);
            if (c.shareId !== run.shareId) history.replaceState(null, "", `/r/${c.shareId}`);
          }}
        />
      )}
    </div>
  );
};
