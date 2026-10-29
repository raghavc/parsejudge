import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type JudgedError, type PageDetail, type PageParse, type Preset, type Run } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { providerName, SHORT_NAMES } from "./names.ts";
import { navigate } from "./router.ts";

type View = "side" | "all";
type Severity = JudgedError["severity"];

interface PageStat {
  readonly id: string;
  readonly filename: string;
  readonly index: number;
  readonly pageCount: number;
  readonly imageUrl: string;
  readonly order: number;
  readonly gap: number;
  readonly failed: boolean;
  readonly high: number;
  readonly lowest: { readonly presetId: string; readonly score: number } | null;
}

const FLAG_GAP = 3;
const BLOCKS = "p,li,td,th,h1,h2,h3,h4,h5,h6,blockquote,pre";
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, not_error: 3 };

const isFlagged = (page: PageStat) => page.failed || page.gap >= FLAG_GAP;
const byGap = (a: PageStat, b: PageStat) => Number(b.failed) - Number(a.failed) || b.gap - a.gap || a.order - b.order;
const byScore = (a: PageParse, b: PageParse) => (b.score ?? -1) - (a.score ?? -1);
const flagsOf = (parse: PageParse) =>
  (parse.errors ?? []).filter((e) => e.severity !== "not_error").sort((a, b) => RANK[a.severity] - RANK[b.severity]);
const pageUrl = (shareId: string, pageId: string, view: View) => `/r/${shareId}/p/${pageId}${view === "all" ? "?view=all" : ""}`;

const pageStats = (run: Run): ReadonlyArray<PageStat> => {
  const cells = new Map<string, Array<Run["scores"][number]>>();
  for (const cell of run.scores) cells.set(cell.pageId, [...(cells.get(cell.pageId) ?? []), cell]);
  return run.documents
    .flatMap((doc) => doc.pages.map((page) => ({ doc, page })))
    .map(({ doc, page }, order) => {
      const own = cells.get(page.id) ?? [];
      const scored = own.flatMap((c) =>
        c.status === "succeeded" && c.score !== null ? [{ presetId: c.presetId, score: c.score }] : [],
      );
      const values = scored.map((c) => c.score);
      return {
        id: page.id,
        filename: doc.filename,
        index: page.index,
        pageCount: doc.pages.length,
        imageUrl: page.imageUrl,
        order,
        gap: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0,
        failed: own.some((c) => c.status === "failed"),
        high: own.reduce((n, c) => n + c.high, 0),
        lowest: scored.reduce<PageStat["lowest"]>((low, c) => (low === null || c.score < low.score ? c : low), null),
      };
    });
};

const useDismiss = (open: boolean, close: () => void) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
};

/** Wraps each located excerpt in a numbered mark and returns the marks per flag. */
const markQuotes = (root: HTMLElement, flags: ReadonlyArray<JudgedError>): Array<Array<HTMLElement>> =>
  flags.map((flag, i) => {
    const marks: Array<HTMLElement> = [];
    for (const quote of flag.quotes ?? []) {
      const q = quote.text;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const matches: Array<{ node: Text; at: number }> = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node as Text;
        if (text.parentElement?.closest(".flag-badges")) continue;
        for (let at = text.data.indexOf(q); at !== -1; at = text.data.indexOf(q, at + 1)) matches.push({ node: text, at });
      }
      const match = matches[quote.occurrence - 1];
      if (match !== undefined) {
        const { node, at } = match;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + q.length);
        const mark = document.createElement("mark");
        mark.className = `flag ${flag.severity}`;
        range.surroundContents(mark);
        marks.push(mark);
        const block = mark.closest("table") ?? mark.closest(BLOCKS) ?? mark;
        block.classList.add("flagged");
        if (flag.severity === "high") block.classList.add("flagged-high");
        let badges = block.querySelector(":scope > .flag-badges");
        if (badges === null) {
          badges = document.createElement("span");
          badges.className = "flag-badges";
          block.append(badges);
        }
        if (badges.querySelector(`[data-n="${i + 1}"]`) === null) {
          const badge = document.createElement("span");
          badge.className = `flag-num ${flag.severity}`;
          badge.dataset.n = String(i + 1);
          badge.textContent = String(i + 1);
          badges.append(badge);
        }
      }
    }
    return marks;
  });

const FlaggedOutput = ({
  markdown,
  flags,
  onFound,
}: {
  readonly markdown: string;
  readonly flags: ReadonlyArray<JudgedError>;
  readonly onFound: (marks: Array<Array<HTMLElement>>) => void;
}) => {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(markdown, { async: false })), [markdown]);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current === null) return;
    ref.current.innerHTML = html;
    onFound(markQuotes(ref.current, flags));
  }, [html, flags, onFound]);
  return <div ref={ref} className="markdown flagged-output" />;
};

const FlagCard = ({
  flag,
  n,
  marks,
}: {
  readonly flag: JudgedError;
  readonly n: number;
  readonly marks: ReadonlyArray<HTMLElement>;
}) => {
  const [next, setNext] = useState(0);
  const jump = () => {
    marks[next % marks.length]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setNext(next + 1);
  };
  return (
    <div className={`flag-card ${flag.severity}`}>
      <div className="flex" style={{ gap: 8 }}>
        <span className={`flag-num ${flag.severity}`}>{n}</span>
        <span className={`sev ${flag.severity}`}>{flag.severity.toUpperCase()}</span>
        <span className="mono" style={{ fontSize: 13 }}>
          {flag.category}
        </span>
        {marks.length > 0 && (
          <button type="button" className="plain jump" onClick={jump}>
            {(next % marks.length) + 1} of {marks.length} ↓
          </button>
        )}
      </div>
      <p>{flag.description}</p>
    </div>
  );
};

const SeverityCounts = ({ parse }: { readonly parse: PageParse }) => {
  const counts = (["high", "medium", "low"] as const)
    .map((sev) => [sev, flagsOf(parse).filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0);
  if (parse.status !== "succeeded") return <span style={{ color: "var(--bad)" }}>Parse failed</span>;
  if (counts.length === 0) return <span>No errors</span>;
  return (
    <span className="flex" style={{ gap: 4 }}>
      {counts.map(([sev, n]) => (
        <span key={sev} className={`sev ${sev}`}>
          {n} {sev.toUpperCase()}
        </span>
      ))}
    </span>
  );
};

const ProviderMenu = ({
  parses,
  current,
  other,
  otherSlot,
  name,
  onPick,
}: {
  readonly parses: ReadonlyArray<PageParse>;
  readonly current: string;
  readonly other: string | undefined;
  readonly otherSlot: string;
  readonly name: (presetId: string) => string;
  readonly onPick: (presetId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" className="plain provider-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        {name(current)} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="popover menu">
          {[...parses].sort(byScore).map((parse) => {
            const taken = parse.presetId === other;
            return (
              <button
                key={parse.presetId}
                type="button"
                className={`menu-row${parse.presetId === current ? " current" : ""}`}
                disabled={taken}
                onClick={() => {
                  onPick(parse.presetId);
                  setOpen(false);
                }}
              >
                <span className="menu-main">
                  <span>
                    {name(parse.presetId)}
                    {parse.presetId === current && " ✓"}
                  </span>
                  <span className="menu-sub">{taken ? `Showing in column ${otherSlot}` : <SeverityCounts parse={parse} />}</span>
                </span>
                <span>{parse.score ?? "–"}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const Score = ({ score, best }: { readonly score: number | null; readonly best: boolean }) => (
  <span className="big-score" style={{ color: best ? "var(--accent)" : "var(--ink)" }}>
    {score ?? "–"}
    <span>/ 10</span>
  </span>
);

const Column = ({
  slot,
  parse,
  best,
  menu,
}: {
  readonly slot: string;
  readonly parse: PageParse;
  readonly best: boolean;
  readonly menu: React.ReactNode;
}) => {
  const flags = useMemo(() => flagsOf(parse), [parse]);
  const [found, setFound] = useState<Array<Array<HTMLElement>>>([]);
  return (
    <article className="pc-col">
      <div className="pc-col-head">
        <div className="flex" style={{ alignItems: "flex-start", justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <div className="slot">{slot}</div>
            {menu}
          </div>
          <Score score={parse.score} best={best} />
        </div>
        {parse.status !== "succeeded" ? (
          <p style={{ color: "var(--bad)" }}>{parse.error ?? "Parse failed."}</p>
        ) : flags.length === 0 ? (
          <>
            <span className="ok-pill">✓ No errors</span>
            <p className="reasoning">{parse.reasoning}</p>
          </>
        ) : (
          <div className="flag-list">
            {flags.map((flag, i) => (
              <FlagCard key={`${flag.category}:${flag.description}`} flag={flag} n={i + 1} marks={found[i] ?? []} />
            ))}
          </div>
        )}
      </div>
      {parse.status === "succeeded" && parse.markdown !== null && (
        <div className="pc-col-body">
          <FlaggedOutput markdown={parse.markdown} flags={flags} onFound={setFound} />
        </div>
      )}
    </article>
  );
};

const DocPicker = ({
  stats,
  current,
  short,
  onPick,
}: {
  readonly stats: ReadonlyArray<PageStat>;
  readonly current: PageStat;
  readonly short: (presetId: string) => string;
  readonly onPick: (pageId: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"flagged" | "all" | "high">(isFlagged(current) ? "flagged" : "all");
  const [sort, setSort] = useState<"gap" | "order">("gap");
  const [cursor, setCursor] = useState(0);
  const close = useMemo(() => () => setOpen(false), []);
  const ref = useDismiss(open, close);
  const counts = { flagged: stats.filter(isFlagged).length, all: stats.length, high: stats.filter((p) => p.high > 0).length };
  const needle = query.trim().toLowerCase();
  const rows = stats
    .filter((p) => filter === "all" || (filter === "flagged" ? isFlagged(p) : p.high > 0))
    .filter((p) => p.filename.toLowerCase().includes(needle))
    .sort(sort === "gap" ? byGap : (a, b) => a.order - b.order)
    .slice(0, 200);
  const pick = (id: string | undefined) => {
    if (id === undefined) return;
    setOpen(false);
    onPick(id);
  };
  return (
    <div ref={ref} style={{ minWidth: 0, position: "relative" }}>
      <button type="button" className="picker-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="clip" title={current.filename}>
          {current.filename}
        </span>
        <span style={{ color: "var(--muted)", flexShrink: 0 }}>p. {current.index + 1}</span>
        <span className="caret">⌄</span>
      </button>
      {open && (
        <div className="popover picker">
          <div style={{ padding: 16 }}>
            <input
              className="search"
              placeholder="Search documents"
              value={query}
              // biome-ignore lint/a11y/noAutofocus: the picker opens to type into.
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setCursor(Math.min(cursor + 1, rows.length - 1));
                else if (e.key === "ArrowUp") setCursor(Math.max(cursor - 1, 0));
                else if (e.key === "Enter") pick(rows[cursor]?.id);
                else return;
                e.preventDefault();
              }}
            />
            <div className="flex" style={{ gap: 6, marginTop: 12 }}>
              {(
                [
                  ["flagged", `Flagged · ${counts.flagged}`],
                  ["all", `All pages · ${counts.all}`],
                  ["high", `High severity · ${counts.high}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`chip-sm${filter === key ? " on" : ""}`}
                  onClick={() => setFilter(key)}
                >
                  {label}
                </button>
              ))}
              <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as "gap" | "order")}>
                <option value="gap">Sort: largest gap</option>
                <option value="order">Sort: document order</option>
              </select>
            </div>
          </div>
          <div className="picker-row picker-head">
            <span>Document · page</span>
            <span>Lowest</span>
            <span>Gap</span>
          </div>
          <div className="picker-rows">
            {rows.length === 0 && <p style={{ color: "var(--muted)", padding: "12px 16px" }}>No pages match.</p>}
            {rows.map((p, i) => (
              <button
                key={p.id}
                type="button"
                className={`picker-row${p.id === current.id ? " viewing" : ""}${i === cursor ? " cursor" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(p.id)}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="clip" style={{ display: "block" }} title={p.filename}>
                    {p.filename}
                  </span>
                  <span className="menu-sub">
                    Page {p.index + 1} of {p.pageCount}
                    {p.id === current.id && " · viewing"}
                  </span>
                </span>
                <span className="flex" style={{ gap: 6 }}>
                  {p.failed ? (
                    <span style={{ color: "var(--bad)" }}>failed</span>
                  ) : p.lowest === null ? (
                    "–"
                  ) : (
                    <>
                      <span className={`dot${p.high > 0 ? " high" : ""}`} />
                      {short(p.lowest.presetId)} {p.lowest.score}
                    </>
                  )}
                </span>
                <span style={{ color: p.id === current.id ? "var(--accent)" : undefined, textAlign: "right" }}>{p.gap}</span>
              </button>
            ))}
          </div>
          <div className="picker-foot">J / K next and previous flagged page · ↑↓ to browse</div>
        </div>
      )}
    </div>
  );
};

const pairKey = (shareId: string) => `parsejudge.pair.${shareId}`;
const loadPair = (shareId: string): ReadonlyArray<string> => {
  try {
    return JSON.parse(localStorage.getItem(pairKey(shareId)) ?? "[]") as Array<string>;
  } catch {
    return [];
  }
};

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
  const [pair, setPair] = useState<ReadonlyArray<string>>(() => loadPair(shareId));

  useEffect(() => {
    api.shared(shareId).then(setRun);
    api.presets().then(setPresets);
  }, [shareId]);

  useEffect(() => {
    if (run === null) return;
    setDetail(null);
    api.page(run.id, pageId).then(setDetail);
  }, [run, pageId]);

  const stats = useMemo(() => (run === null ? [] : pageStats(run)), [run]);
  const flagged = useMemo(() => stats.filter(isFlagged).sort(byGap), [stats]);
  const position = stats.findIndex((p) => p.id === pageId);
  const current = stats[position];
  const at = flagged.findIndex((p) => p.id === pageId);
  const prevFlagged = at === -1 ? flagged.at(-1) : flagged[at - 1];
  const nextFlagged = at === -1 ? flagged[0] : flagged[at + 1];
  const go = (id: string | undefined, nextView: View = view) => id !== undefined && navigate(pageUrl(shareId, id, nextView));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") go(nextFlagged?.id);
      if (event.key === "k") go(prevFlagged?.id);
      if (event.key === "ArrowLeft") go(stats[position - 1]?.id);
      if (event.key === "ArrowRight") go(stats[position + 1]?.id);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (run === null || current === undefined) return <p style={{ padding: 24 }}>Loading…</p>;

  const presetOf = (id: string) => presets.find((p) => p.id === id);
  const runProviders = run.presetIds.map((id) => presetOf(id)?.provider);
  const name = (id: string) => {
    const preset = presetOf(id);
    if (preset === undefined) return id;
    const siblings = runProviders.filter((p) => p === preset.provider).length;
    return siblings > 1 ? `${providerName(preset.provider)} · ${preset.mode}` : providerName(preset.provider);
  };
  const short = (id: string) => {
    const provider = presetOf(id)?.provider;
    return provider === undefined ? id : (SHORT_NAMES[provider] ?? provider);
  };

  const parses = detail?.parses ?? [];
  const best = Math.max(...parses.map((p) => p.score ?? -1));
  const ranked = [...parses].sort(byScore);
  const ids = parses.map((p) => p.presetId);
  const a = pair[0] !== undefined && ids.includes(pair[0]) ? pair[0] : ranked[0]?.presetId;
  const b =
    pair[1] !== undefined && ids.includes(pair[1]) && pair[1] !== a
      ? pair[1]
      : ranked.findLast((p) => p.presetId !== a)?.presetId;
  const choose = (slot: 0 | 1, id: string) => {
    const next = slot === 0 ? [id, b ?? ""] : [a ?? "", id];
    setPair(next);
    localStorage.setItem(pairKey(shareId), JSON.stringify(next));
  };
  const issues = parses.reduce((n, p) => n + flagsOf(p).length, 0);

  return (
    <div className="pc">
      <header className="pc-header">
        <div className="flex" style={{ gap: 16, minWidth: 0 }}>
          <button type="button" className="plain" style={{ flexShrink: 0 }} onClick={() => navigate(`/r/${shareId}`)}>
            Parse Judge
          </button>
          <span style={{ color: "var(--faint)" }}>/</span>
          <DocPicker stats={stats} current={current} short={short} onPick={(id) => go(id)} />
        </div>
        <div className="flex" style={{ gap: 12 }}>
          {flagged.length > 0 && (
            <div className="seg">
              <button
                type="button"
                aria-label="Previous flagged page"
                disabled={prevFlagged === undefined}
                onClick={() => go(prevFlagged?.id)}
              >
                ‹
              </button>
              <span>{at === -1 ? `${flagged.length} flagged` : `Flagged ${at + 1} of ${flagged.length}`}</span>
              <button
                type="button"
                aria-label="Next flagged page"
                disabled={nextFlagged === undefined}
                onClick={() => go(nextFlagged?.id)}
              >
                ›
              </button>
            </div>
          )}
          <div className="seg toggle">
            {(["side", "all"] as const).map((v) => (
              <button key={v} type="button" className={view === v ? "on" : ""} onClick={() => go(pageId, v)}>
                {v === "side" ? "Side by side" : "Table"}
              </button>
            ))}
          </div>
          <CopyButton text={location.href} label="Copy link" />
        </div>
      </header>
      <div className="split pc-body">
        <aside className={`pc-original${view === "all" ? " narrow" : ""}`}>
          <div className="eyebrow">Original</div>
          <img src={current.imageUrl} alt={`${current.filename}, page ${current.index + 1}`} />
        </aside>
        {detail === null && <p style={{ padding: 24 }}>Loading…</p>}
        {detail !== null && view === "side" && (
          <div className="pc-cols">
            {([a, b] as const).map((id, slot) => {
              const parse = parses.find((p) => p.presetId === id);
              if (parse === undefined) return null;
              return (
                <Column
                  key={parse.presetId}
                  slot={"AB"[slot] ?? ""}
                  parse={parse}
                  best={parse.score === best}
                  menu={
                    <ProviderMenu
                      parses={parses}
                      current={parse.presetId}
                      other={slot === 0 ? b : a}
                      otherSlot={slot === 0 ? "B" : "A"}
                      name={name}
                      onPick={(next) => choose(slot === 0 ? 0 : 1, next)}
                    />
                  }
                />
              );
            })}
          </div>
        )}
        {detail !== null && view === "all" && (
          <main className="pc-table">
            <div className="flex" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12, justifyContent: "space-between" }}>
              <div>
                <h2>Every provider on this page</h2>
                <p className="reasoning" style={{ margin: "4px 0 0" }}>
                  Scores and issues for every provider. Switch to Side by side to read the outputs.
                </p>
              </div>
              <span style={{ color: "var(--muted)", fontSize: 13 }}>
                {parses.length} providers · {issues} issues
              </span>
            </div>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Score</th>
                    <th>Issues the judge found</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((parse) => {
                    const flags = flagsOf(parse);
                    return (
                      <tr key={parse.presetId}>
                        <td>
                          <div>{providerName(presetOf(parse.presetId)?.provider ?? parse.presetId)}</div>
                          <div className="menu-sub">{presetOf(parse.presetId)?.mode}</div>
                        </td>
                        <td className="table-score" style={{ color: parse.score === best ? "var(--accent)" : undefined }}>
                          {parse.score ?? "–"}
                        </td>
                        <td>
                          {parse.status !== "succeeded" ? (
                            <span style={{ color: "var(--bad)" }}>{parse.error ?? "Parse failed."}</span>
                          ) : flags.length === 0 ? (
                            <>
                              <div style={{ color: "var(--good)" }}>✓ No errors</div>
                              <div className="reasoning">{parse.reasoning}</div>
                            </>
                          ) : (
                            flags.map((flag) => (
                              <div key={`${flag.category}:${flag.description}`} className="table-flag">
                                <span className={`sev ${flag.severity}`}>{flag.severity.toUpperCase()}</span>
                                <div>
                                  <div className="mono" style={{ fontSize: 13 }}>
                                    {flag.category}
                                  </div>
                                  <div>{flag.description}</div>
                                </div>
                              </div>
                            ))
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </main>
        )}
      </div>
    </div>
  );
};
