import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import { api, type JudgedError, type PageDetail, type PageParse, type Preset, type Run } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { SHORT_NAMES } from "./names.ts";
import { navigate } from "./router.ts";

type View = "side" | "all";
type OutputTab = "rendered" | "markdown" | "raw";

interface PageEntry {
  readonly id: string;
  readonly filename: string;
  readonly index: number;
  readonly imageUrl: string;
}

const pageUrl = (shareId: string, pageId: string, view: View) => `/r/${shareId}/p/${pageId}${view === "all" ? "?view=all" : ""}`;

/** Pages where the providers disagree most come first; a failed parse counts as a flag. */
const flaggedPages = (run: Run): ReadonlyArray<{ pageId: string; spread: number; failed: boolean }> => {
  const byPage = new Map<string, { scores: Array<number>; failed: boolean }>();
  for (const cell of run.scores) {
    const entry = byPage.get(cell.pageId) ?? { scores: [], failed: false };
    if (cell.score !== null) entry.scores.push(cell.score);
    if (cell.status === "failed") entry.failed = true;
    byPage.set(cell.pageId, entry);
  }
  return [...byPage.entries()]
    .map(([pageId, { scores, failed }]) => ({
      pageId,
      spread: scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0,
      failed,
    }))
    .filter((page) => page.failed || page.spread >= 3)
    .sort((a, b) => Number(b.failed) - Number(a.failed) || b.spread - a.spread);
};

const ErrorList = ({ errors }: { readonly errors: ReadonlyArray<JudgedError> }) => (
  <div>
    {errors
      .filter((error) => error.severity !== "not_error")
      .map((error) => (
        <div key={`${error.category}:${error.description}`} style={{ borderTop: "1px solid var(--rule)", padding: "12px 0" }}>
          <div className="flex" style={{ gap: 8 }}>
            <span className={`tag ${error.severity}`}>{error.severity.toUpperCase()}</span>
            <span className="mono">{error.category}</span>
          </div>
          <p style={{ margin: "8px 0 0" }}>{error.description}</p>
        </div>
      ))}
  </div>
);

const Output = ({ parse }: { readonly parse: PageParse }) => {
  const [tab, setTab] = useState<OutputTab>("rendered");
  const html = useMemo(
    () => (parse.markdown === null ? "" : DOMPurify.sanitize(marked.parse(parse.markdown, { async: false }))),
    [parse.markdown],
  );
  if (parse.status !== "succeeded") return <p style={{ color: "var(--bad)" }}>{parse.error ?? "Parse failed."}</p>;
  return (
    <div>
      <div className="flex" style={{ borderBottom: "1px solid var(--rule)", gap: 16, marginBottom: 16 }}>
        {(["rendered", "markdown", "raw"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className="plain"
            onClick={() => setTab(name)}
            style={{ borderBottom: tab === name ? "2px solid var(--ink)" : "2px solid transparent", paddingBottom: 8 }}
          >
            {name === "raw" ? "Raw JSON" : name[0]?.toUpperCase() + name.slice(1)}
          </button>
        ))}
      </div>
      {tab === "rendered" && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized with DOMPurify above.
        <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />
      )}
      {tab === "markdown" && (
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {parse.markdown}
        </pre>
      )}
      {tab === "raw" && (
        <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>
          {JSON.stringify(parse, null, 2)}
        </pre>
      )}
    </div>
  );
};

const Score = ({ score, accent }: { readonly score: number | null; readonly accent: boolean }) => (
  <span style={{ fontSize: 40, color: accent ? "var(--accent)" : "var(--ink)" }}>
    {score ?? "–"}
    <span style={{ color: "var(--faint)", fontSize: 16 }}> / 10</span>
  </span>
);

export const PageCompare = ({
  shareId,
  pageId,
  view,
}: {
  readonly shareId: string;
  readonly pageId: string;
  readonly view: View;
}) => {
  const [run, setRun] = useState<Run | null>(null);
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);

  useEffect(() => {
    api.shared(shareId).then(setRun);
    api.presets().then(setPresets);
  }, [shareId]);

  useEffect(() => {
    if (run === null) return;
    setDetail(null);
    api.page(run.id, pageId).then((page) => {
      setDetail(page);
      const ranked = [...page.parses].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
      setPicked([ranked[0]?.presetId, ranked.at(-1)?.presetId].filter((id): id is string => id !== undefined));
    });
  }, [run, pageId]);

  const pages: ReadonlyArray<PageEntry> = useMemo(
    () => (run?.documents ?? []).flatMap((doc) => doc.pages.map((page) => ({ ...page, filename: doc.filename }))),
    [run],
  );
  const flagged = useMemo(() => (run === null ? [] : flaggedPages(run)), [run]);
  const position = pages.findIndex((page) => page.id === pageId);
  const current = pages[position];
  const label = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    return preset?.label ?? presetId;
  };
  const shortLabel = (presetId: string) => {
    const provider = presets.find((p) => p.id === presetId)?.provider;
    return provider === undefined ? presetId : (SHORT_NAMES[provider] ?? provider);
  };
  const go = (id: string | undefined, nextView: View = view) => id !== undefined && navigate(pageUrl(shareId, id, nextView));
  const nextFlagged = () => {
    const after = flagged.findIndex((page) => page.pageId === pageId);
    go(flagged[(after + 1) % Math.max(flagged.length, 1)]?.pageId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "j") nextFlagged();
      if (event.key === "ArrowLeft") go(pages[position - 1]?.id);
      if (event.key === "ArrowRight") go(pages[position + 1]?.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (run === null || current === undefined) return <p style={{ padding: 24 }}>Loading…</p>;
  const pageName = (id: string) => {
    const page = pages.find((p) => p.id === id);
    return page === undefined ? id : `${page.filename} · p. ${page.index + 1}`;
  };
  const parses = detail?.parses ?? [];
  const best = Math.max(...parses.map((p) => p.score ?? -1));

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        className="flex"
        style={{
          borderBottom: "1px solid var(--rule)",
          flexWrap: "wrap",
          gap: "12px 24px",
          justifyContent: "space-between",
          padding: "14px 24px",
        }}
      >
        <button type="button" className="plain" onClick={() => navigate(`/r/${shareId}`)}>
          Parse Judge <span style={{ color: "var(--faint)" }}>/</span> <span style={{ color: "var(--muted)" }}>Report</span>
        </button>
        <div className="flex" style={{ gap: 16, minWidth: 0 }}>
          <span className="clip" style={{ color: "var(--muted)", maxWidth: 320 }} title={current.filename}>
            {current.filename}
          </span>
          <button type="button" className="plain" disabled={position <= 0} onClick={() => go(pages[position - 1]?.id)}>
            ‹
          </button>
          <span>
            Page {position + 1} of {pages.length}
          </span>
          <button
            type="button"
            className="plain"
            disabled={position >= pages.length - 1}
            onClick={() => go(pages[position + 1]?.id)}
          >
            ›
          </button>
          <button type="button" className="plain" disabled={flagged.length === 0} onClick={nextFlagged}>
            Next flagged page <span className="tag low">J</span>
          </button>
        </div>
        <div className="flex" style={{ gap: 8 }}>
          <CopyButton text={location.href} label="Copy link to page" />
          <div className="flex" style={{ border: "1px solid var(--line)" }}>
            {(["side", "all"] as const).map((name) => (
              <button
                key={name}
                type="button"
                className={`btn${view === name ? " primary" : ""}`}
                style={{ border: "none" }}
                onClick={() => go(pageId, name)}
              >
                {name === "side" ? "Side by side" : "All providers"}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="split" style={{ display: "flex", flex: 1 }}>
        {view === "side" && (
          <aside
            className="wide-only"
            style={{ borderRight: "1px solid var(--rule)", flexShrink: 0, padding: "24px 0", width: 230 }}
          >
            <div className="eyebrow" style={{ padding: "0 20px 12px" }}>
              Flagged · all documents
            </div>
            {flagged.length === 0 && <p style={{ color: "var(--muted)", padding: "0 20px" }}>No disagreements.</p>}
            {flagged.map((page) => (
              <button
                key={page.pageId}
                type="button"
                className="plain"
                onClick={() => go(page.pageId)}
                style={{
                  background: page.pageId === pageId ? "#F3F5FD" : undefined,
                  borderLeft: page.pageId === pageId ? "2px solid var(--accent)" : "2px solid transparent",
                  justifyContent: "space-between",
                  padding: "10px 20px",
                  width: "100%",
                }}
              >
                <span>{pageName(page.pageId)}</span>
                <span style={{ marginLeft: "auto", color: page.failed ? "var(--bad)" : "var(--muted)" }}>
                  {page.failed ? "failed" : `gap ${page.spread}`}
                </span>
              </button>
            ))}
          </aside>
        )}
        <section style={{ background: "#F7F7F7", padding: 24, width: view === "side" ? 460 : 436 }}>
          <div className="flex" style={{ justifyContent: "space-between", marginBottom: 12 }}>
            <span className="eyebrow">Original page</span>
            <span style={{ color: "var(--muted)" }}>same image sent to all</span>
          </div>
          <img src={current.imageUrl} alt={pageName(pageId)} style={{ background: "#fff", width: "100%" }} />
        </section>
        <main style={{ flex: 1, padding: 24 }}>
          {detail === null && <p>Loading…</p>}
          {detail !== null && view === "side" && (
            <>
              <div className="flex" style={{ flexWrap: "wrap", gap: 8, marginBottom: 24 }}>
                <span className="eyebrow">Score · 1 to 10</span>
                {parses.map((parse) => {
                  const slot = picked.indexOf(parse.presetId);
                  return (
                    <button
                      key={parse.presetId}
                      type="button"
                      className={`btn chip${slot === 0 ? " primary" : slot === 1 ? " picked" : ""}`}
                      onClick={() => setPicked(slot >= 0 ? picked : [picked[0] ?? parse.presetId, parse.presetId])}
                    >
                      {slot >= 0 ? `${"AB"[slot]} ` : ""}
                      {shortLabel(parse.presetId)} {parse.score ?? "–"}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
                {picked.map((presetId, slot) => {
                  const parse = parses.find((p) => p.presetId === presetId);
                  if (parse === undefined) return null;
                  return (
                    <article key={presetId}>
                      <div className="flex" style={{ justifyContent: "space-between" }}>
                        <div>
                          <div style={{ color: "var(--muted)" }}>{"AB"[slot]}</div>
                          <h3 style={{ margin: 0 }}>{label(presetId)}</h3>
                        </div>
                        <Score score={parse.score} accent={parse.score === best} />
                      </div>
                      <Output parse={parse} />
                      <div className="eyebrow" style={{ marginTop: 24 }}>
                        Judge reasoning
                      </div>
                      <p>{parse.reasoning ?? "Not judged."}</p>
                      <div className="eyebrow">
                        Errors · {(parse.errors ?? []).filter((e) => e.severity !== "not_error").length}
                      </div>
                      <ErrorList errors={parse.errors ?? []} />
                    </article>
                  );
                })}
              </div>
            </>
          )}
          {detail !== null && view === "all" && (
            <>
              <h2 style={{ margin: 0 }}>All providers on this page</h2>
              <p style={{ color: "var(--muted)", marginTop: 4 }}>
                One judge call saw the page image and all {parses.length} outputs under shuffled labels.
              </p>
              <div
                style={{
                  borderTop: "1px solid var(--ink)",
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  paddingTop: 24,
                }}
              >
                {[...parses]
                  .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
                  .map((parse) => (
                    <article key={parse.presetId}>
                      <div>{label(parse.presetId)}</div>
                      <Score score={parse.score} accent={parse.score === best} />
                      <p style={{ color: "var(--muted)" }}>{parse.reasoning ?? parse.error ?? "Not judged."}</p>
                      <ErrorList errors={parse.errors ?? []} />
                    </article>
                  ))}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
};
