import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { api, type PageDetail, type Preset, type PresetSummary, type Run } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { perThousand, providerName, seconds, shortName } from "./names.ts";
import { navigate } from "./router.ts";

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

/** A 560×300 scatter. `frontier` is drawn as a dashed accent line through those points, then flat to the edge. */
const Scatter = ({
  points,
  yMin,
  yMax,
  yTick,
  frontier = [],
}: {
  readonly points: ReadonlyArray<Point>;
  readonly yMin: number;
  readonly yMax: number;
  readonly yTick: (y: number) => string;
  readonly frontier?: ReadonlyArray<Point>;
}) => {
  const W = 560;
  const H = 300;
  const L = 40;
  const B = 32;
  const xMax = Math.max(1, ...points.map((p) => p.x)) * 1.15;
  const sx = (x: number) => L + (x / xMax) * (W - L - 10);
  const sy = (y: number) => 10 + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - B - 20);
  const xTicks = ticks(0, xMax, 5);
  const yTicks = ticks(yMin, yMax, 3);
  const path = frontier.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x)},${sy(p.y)}`).join(" ");
  const last = frontier.at(-1);
  return (
    <svg width={W} height={H} style={{ overflow: "visible" }} role="img" aria-label="chart">
      <line x1={L} x2={W} y1={H - B} y2={H - B} stroke="var(--ink)" />
      {yTicks.map((y) => (
        <text key={y} x={L - 12} y={sy(y) + 4} fontSize={12} fill="var(--faint)" textAnchor="end">
          {yTick(y)}
        </text>
      ))}
      {xTicks.map((x, i) => (
        <text key={x} x={sx(x)} y={H - 10} fontSize={12} fill="var(--faint)" textAnchor="middle">
          {`${+(x / 1000).toFixed(1)} s${i === xTicks.length - 1 ? " · p50" : ""}`}
        </text>
      ))}
      {last && (
        <path d={`${path} L${W},${sy(last.y)}`} fill="none" stroke="var(--accent)" strokeDasharray="4 4" strokeWidth={1.5} />
      )}
      {points.map((p) => {
        const right = sx(p.x) > W - 140;
        return (
          <g key={p.id}>
            <circle cx={sx(p.x)} cy={sy(p.y)} r={5} fill={p.accent ? "var(--accent)" : "var(--ink)"} />
            <text
              x={sx(p.x) + (right ? -10 : 10)}
              y={sy(p.y) - 8}
              fontSize={13}
              fill="var(--ink)"
              textAnchor={right ? "end" : "start"}
            >
              {p.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

/** Each provider's score on one page, on a 1–10 strip. */
const Dots = ({ scores }: { readonly scores: ReadonlyArray<number | null> }) => {
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
  const disagreements = pages
    .map((page) => {
      const cells = run.presetIds.map((id) => run.scores.find((s) => s.pageId === page.id && s.presetId === id));
      const scores = cells.map((c) => (c?.status === "succeeded" ? (c.score ?? null) : null));
      const ok = scores.filter((s): s is number => s !== null);
      const failed = scores.length - ok.length;
      return { page, scores, failed, gap: ok.length > 1 ? Math.max(...ok) - Math.min(...ok) : 0 };
    })
    .filter((d) => d.gap >= 3 || d.failed > 0);
  const [filter, setFilter] = useState<"gap" | "failed">("gap");
  const shown = disagreements
    .filter((d) => filter === "gap" || d.failed > 0)
    .sort((a, b) => (filter === "gap" ? b.gap - a.gap : b.failed - a.failed))
    .slice(0, 8);

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

  if (summary === null) return <div style={{ ...note, padding: "72px 120px" }}>This run failed: {run.error}</div>;

  const scored = ranked.filter(
    (p): p is PresetSummary & { meanScore: number; latencyMsP50: number } => p.meanScore !== null && p.latencyMsP50 !== null,
  );
  const byLatency = [...scored].sort((a, b) => a.latencyMsP50 - b.latencyMsP50);
  const frontierIds = new Set<string>();
  let bestSoFar = -1;
  for (const p of byLatency) {
    if (p.meanScore > bestSoFar) {
      frontierIds.add(p.presetId);
      bestSoFar = p.meanScore;
    }
  }
  const scorePoints: ReadonlyArray<Point> = byLatency.map((p) => ({
    id: p.presetId,
    label: `${name(p.presetId)} · ${p.meanScore.toFixed(1)}`,
    x: p.latencyMsP50,
    y: p.meanScore,
    accent: frontierIds.has(p.presetId),
  }));
  const costPoints: ReadonlyArray<Point> = byLatency.map((p) => ({
    id: p.presetId,
    label: `${name(p.presetId)} · ${perThousand(p.listPriceUsdPerPage)}`,
    x: p.latencyMsP50,
    y: p.listPriceUsdPerPage * 1000,
    accent: false,
  }));
  const minScore = Math.floor(Math.min(10, ...scored.map((p) => p.meanScore)) - 1);
  const maxCost = Math.max(10, ...costPoints.map((p) => p.y)) * 1.15;
  const pageCount = pages.length;
  const date = new Date(run.createdAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  const mcp = `claude mcp add parsejudge ${location.origin}/mcp`;
  const h2h = (a: string, b: string) => summary.headToHead.find((h) => h.presetId === a && h.opponentId === b);
  const exportRun = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: `parsejudge-${run.shareId}.json` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stagger">
      <section style={{ alignItems: "end", display: "flex", justifyContent: "space-between", padding: "72px 120px 56px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="eyebrow" style={{ fontSize: 13 }}>
            Evaluation report · {date}
          </div>
          <div style={{ fontSize: 56, fontWeight: 300, letterSpacing: "-0.035em", lineHeight: "62px", maxWidth: 820 }}>
            {title}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 15 }}>
            {run.documents.length} documents · {pageCount} pages · {run.presetIds.length} providers ·{" "}
            {pageCount * run.presetIds.length} parses judged blind
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            style={{ height: 40, padding: "0 16px" }}
            onClick={() => navigate(`${location.pathname}?share=1`)}
          >
            Share
          </button>
          <button type="button" className="btn" style={{ height: 40, padding: "0 16px" }} onClick={exportRun}>
            Export
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ fontWeight: 500, height: 40, padding: "0 16px" }}
            onClick={() => navigate("/")}
          >
            Run again
          </button>
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", padding: "0 120px 72px" }}>
        <div
          className="eyebrow"
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
            <div key={p.presetId} className="row" style={{ fontSize: 14, gap: 24, padding: "22px 0" }}>
              <div style={{ color: "var(--muted)", width: cols.rank }}>{i + 1}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, width: cols.provider }}>
                <div style={{ fontSize: 16, lineHeight: "20px" }}>{preset ? providerName(preset.provider) : p.label}</div>
                <div style={{ color: "var(--muted)", fontSize: 13 }}>
                  {preset?.mode}
                  {preset && !preset.hosted && " · your key"}
                </div>
              </div>
              <div style={{ alignItems: "center", display: "flex", flexGrow: 1, gap: 20 }}>
                <div style={{ fontSize: 24, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: "30px", width: 48 }}>
                  {p.meanScore === null ? "–" : p.meanScore.toFixed(1)}
                </div>
                <div style={{ background: "#F2F2F2", display: "flex", flexGrow: 1, height: 4 }}>
                  <div style={{ background: "var(--ink)", height: 4, width: `${((p.meanScore ?? 0) / 10) * 100}%` }} />
                </div>
              </div>
              <div style={{ textAlign: "right", width: cols.high }}>
                {p.highSeverityRate === null ? "–" : pct(p.highSeverityRate)}
                {p.highSeverityInterval && (
                  <span style={{ color: "var(--faint)" }}>
                    {" "}
                    ({Math.round(p.highSeverityInterval.low * 100)}–{pct(p.highSeverityInterval.high).replace("%", "")})
                  </span>
                )}
              </div>
              <div style={{ textAlign: "right", width: cols.price }}>{perThousand(p.listPriceUsdPerPage)}</div>
              <div style={{ textAlign: "right", width: cols.latency }}>
                {seconds(p.latencyMsP50).replace(" s", "")} · {seconds(p.latencyMsP95)}
              </div>
              <div style={{ color: p.failedPages > 0 ? "var(--bad)" : "var(--muted)", textAlign: "right", width: cols.failed }}>
                {p.failedPages}
              </div>
            </div>
          );
        })}
      </section>

      <section style={{ borderTop: "1px solid var(--line)", display: "flex", gap: 80, padding: "56px 120px 64px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, width: 560 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={h2}>Latency vs. score</div>
            <div style={{ ...note, fontSize: 13, lineHeight: "16px" }}>
              Up and to the left is better. The line marks the best score at each latency.
            </div>
          </div>
          <Scatter
            points={scorePoints}
            yMin={minScore}
            yMax={10}
            yTick={(y) => String(Math.round(y))}
            frontier={scorePoints.filter((p) => p.accent)}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20, width: 560 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={h2}>Latency vs. cost</div>
            <div style={{ ...note, fontSize: 13, lineHeight: "16px" }}>
              Down and to the left is better. List prices per 1k pages.
            </div>
          </div>
          <Scatter points={costPoints} yMin={0} yMax={maxCost} yTick={(y) => (y === 0 ? "" : `$${Math.round(y)}`)} />
        </div>
      </section>

      <section style={{ borderTop: "1px solid var(--line)", display: "flex", gap: 80, padding: "56px 120px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
          <div style={h2}>Head to head</div>
          <div style={note}>
            Pages where the row provider scored higher, the same, or lower than the column provider. {pageCount} pages.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ borderBottom: "1px solid var(--ink)", display: "flex", paddingBottom: 10 }}>
            <div style={{ width: 140 }} />
            {ranked.map((c) => (
              <div key={c.presetId} style={{ color: "var(--muted)", flex: "1 0 0", fontSize: 13 }}>
                vs {name(c.presetId)}
              </div>
            ))}
          </div>
          {ranked.map((r) => (
            <div key={r.presetId} className="row" style={{ fontSize: 14, padding: "14px 0" }}>
              <div style={{ width: 140 }}>{name(r.presetId)}</div>
              {ranked.map((c) => {
                const h = h2h(r.presetId, c.presetId);
                return (
                  <div key={c.presetId} style={{ color: h ? "var(--ink)" : "#BDBDBD", flex: "1 0 0" }}>
                    {h ? (
                      <>
                        <span style={{ color: "var(--good)" }}>{h.wins}</span> · {h.ties} ·{" "}
                        <span style={{ color: "var(--bad)" }}>{h.losses}</span>
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
            the row provider.
          </div>
        </div>
      </section>

      <section
        style={{
          alignItems: "center",
          background: "#F7F7F7",
          borderRadius: 6,
          display: "flex",
          gap: 40,
          justifyContent: "space-between",
          margin: "0 120px 72px",
          padding: "28px 32px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 420 }}>
          <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: "22px" }}>
            Ask your agent about your evals
          </div>
          <div style={note}>
            One MCP server for Parse Judge. Sign in once and your agent can browse every run you have access to, including this
            one.
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, gap: 10 }}>
          <div
            style={{
              alignItems: "center",
              background: "#fff",
              border: "1px solid var(--line)",
              borderRadius: 4,
              display: "flex",
              justifyContent: "space-between",
              padding: "12px 16px",
            }}
          >
            <span className="mono" style={{ fontSize: 13 }}>
              {mcp}
            </span>
            <CopyButton text={mcp} label="Copy" className="u" style={{ fontSize: 13 }} />
          </div>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            Try: "On run {run.shareId}, show me the pages where the providers disagree most and why."
          </div>
        </div>
      </section>

      <section
        style={{
          borderTop: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          gap: 28,
          padding: "56px 120px 72px",
        }}
      >
        <div style={{ alignItems: "end", display: "flex", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={h2}>Where providers disagree</div>
            <div style={note}>
              {disagreements.length} of {pageCount} pages have a gap of 3 or more points between the best and worst score, or a
              failed parse.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {(
              [
                ["gap", "Largest gap"],
                ["failed", `Failed · ${disagreements.filter((d) => d.failed > 0).length}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                style={{
                  background: filter === key ? "var(--ink)" : "#fff",
                  border: `1px solid ${filter === key ? "var(--ink)" : "var(--line)"}`,
                  borderRadius: 16,
                  color: filter === key ? "#fff" : "var(--ink)",
                  fontSize: 13,
                  height: 32,
                  padding: "0 12px",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 ? (
          <div style={note}>Every provider scored within 3 points of the others on every page.</div>
        ) : (
          <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(4, 1fr)" }}>
            {shown.map((d) => {
              const detail = details.get(d.page.id);
              const worst = detail?.parses.filter((p) => p.reasoning !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];
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
                    style={{ aspectRatio: "4 / 5", background: "var(--panel)", display: "flex", overflow: "hidden", padding: 16 }}
                  >
                    <img
                      src={d.page.imageUrl}
                      alt={d.page.label}
                      style={{ boxShadow: "0 1px 2px #0001", objectFit: "contain", width: "100%" }}
                    />
                  </div>
                  <div style={{ display: "flex", fontSize: 14, justifyContent: "space-between", marginTop: 14 }}>
                    <span>{d.page.label}</span>
                    <span style={{ color: d.failed > 0 ? "var(--bad)" : "var(--muted)", fontSize: 13 }}>
                      {d.failed > 0 ? `${d.failed} failed` : `gap ${d.gap}`}
                    </span>
                  </div>
                  <Dots scores={d.scores} />
                  <div style={{ ...note, fontSize: 13, lineHeight: "18px" }}>{worst?.reasoning}</div>
                </a>
              );
            })}
          </div>
        )}
        <div style={{ alignItems: "center", display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <div style={{ alignItems: "center", color: "var(--muted)", display: "flex", gap: 16 }}>
            <span>
              <span style={{ color: "var(--accent)" }}>●</span> best output
            </span>
            <span>○ worst output</span>
            <span>Dots show each provider's score on this page, from 1 to 10.</span>
          </div>
          {pages[0] && (
            <button type="button" style={{ fontSize: 14 }} onClick={() => navigate(`/r/${run.shareId}/p/${pages[0]?.id}`)}>
              Browse all {pageCount} pages →
            </button>
          )}
        </div>
      </section>

      <section
        style={{
          background: "#FAFAFA",
          borderTop: "1px solid var(--line)",
          display: "flex",
          gap: 80,
          padding: "48px 120px 64px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6, width: 280 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>How this was scored</div>
          <div style={{ ...note, fontSize: 13, lineHeight: "20px" }}>
            Read the methodology and the judge prompt, or reproduce this run on your own hardware.
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
    </div>
  );
};
