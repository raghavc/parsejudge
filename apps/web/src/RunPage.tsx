import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CellDone, currentUser, type Preset, type Run } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { ContinueRun } from "./ContinueRun.tsx";
import { DeleteRun } from "./DeleteRun.tsx";
import { Go, Shell } from "./Nav.tsx";
import { providerName, seconds } from "./names.ts";
import { Report } from "./Report.tsx";
import { ShareDialog } from "./Share.tsx";

export const runTitle = (run: Run) => {
  if (run.title) return run.title;
  const names = run.documents.map((d) => d.filename.replace(/\.[^.]+$/, ""));
  if (names.length <= 2) return names.join(" and ");
  return `${names.length} documents`;
};

const p50 = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
};

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const Bar = ({ value }: { readonly value: number }) => (
  <span className="lp-bar">
    <span style={{ transform: `scaleX(${value})` }} />
  </span>
);

/** The load state while a run is in flight: live counts from the run's event socket, and Continue for the owner. */
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
  const user = currentUser();
  const started = new Date(run.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="page rp-page lp-page">
      <div className="rp-head">
        <div className="title-wrap">
          <div className="lp-status">
            <span className="spin" />
            {pages === 0 ? "Preparing pages" : judgeDone ? "Summarizing" : "Running"} · {elapsed(now - run.createdAt)} elapsed
          </div>
          <h1>{runTitle(run)}</h1>
          <div className="pg-meta">
            {run.documents.length} documents · {pages} pages · {run.presetIds.length} providers · started {started}
          </div>
        </div>
        <div className="lp-pct">
          <div className="lp-pct-n">{Math.floor(progress * 100)}%</div>
          <div className="pg-meta">
            {all.length} of {total} parses · {judged} of {pages} pages judged
          </div>
        </div>
      </div>
      <Bar value={progress} />

      <section className="wf-table lb lp">
        <div className="thead">
          <div>Provider</div>
          <div>Pages</div>
          <div className="num">Done</div>
          <div className="num">p50 latency</div>
          <div className="num">Status</div>
        </div>
        {run.presetIds.map((id) => {
          const preset = presets.find((p) => p.id === id);
          const mine = all.filter((c) => c.presetId === id);
          const failed = mine.filter((c) => !c.ok).length;
          const latency = p50(mine.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs])));
          const finished = pages > 0 && mine.length === pages;
          const status = finished ? "Done" : mine.length === 0 && !startedPresets.has(id) ? "Queued" : "Parsing";
          return (
            <div key={id} className="trow">
              <div className="who-t">
                <div className="who-n">{preset ? providerName(preset.provider) : id}</div>
                {preset && <div className="who-m">{preset.mode}</div>}
              </div>
              <Bar value={pages === 0 ? 0 : mine.length / pages} />
              <div className="num">
                {mine.length} / {pages}
              </div>
              <div className="num soft">{seconds(latency)}</div>
              <div className={`num${finished ? "" : " soft"}`}>
                {status}
                {failed > 0 && <span className="lp-bad"> · {failed} failed</span>}
              </div>
            </div>
          );
        })}
        <div className="trow">
          <div className="who-t">
            <div className="who-n">Judge</div>
            <div className="who-m">{run.judgeModel.replace(/^.*\//, "")}</div>
          </div>
          <Bar value={pages === 0 ? 0 : judged / pages} />
          <div className="num">
            {judged} / {pages}
          </div>
          <div className="num soft">–</div>
          <div className={`num${judgeDone ? "" : " soft"}`}>{judgeDone ? "Done" : judged > 0 ? "Judging" : "Waiting"}</div>
        </div>
      </section>

      <div className="lp-foot">
        <div className="pg-meta">
          You can close this tab.
          {user ? ` We'll email ${user} when the report is ready.` : " The link below opens the report when it is ready."}
        </div>
        <div className="lp-acts">
          {run.owned && pages > 0 && <ContinueRun runId={run.id} skip={pages - judged} onDone={onDone} />}
        </div>
      </div>
    </div>
  );
};

export const RunPage = ({ shareId }: { readonly shareId: string }) => {
  const [run, setRun] = useState<Run | null>(null);
  const [presets, setPresets] = useState<Awaited<ReturnType<typeof api.presets>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [reveal, setReveal] = useState("");
  const waited = useRef(false);

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
  const live = run !== null && !finished && run.status !== "failed";
  if (live) waited.current = true;
  /* a run that finishes while open: the load state fades out, then the report rises in */
  useEffect(() => {
    if (!finished || !waited.current) return;
    setReveal("is-pre");
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setReveal("is-in")));
    const timer = setTimeout(() => setReveal(""), 700);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [finished]);

  const title = run ? runTitle(run) : "";
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  const topbar = (
    <div className="topbar">
      <nav className="crumb tb-crumb" aria-label="Breadcrumb">
        <Go to="/">Parse Judge</Go>
        <span className="sep">/</span>
        <span className="cur">{title}</span>
      </nav>
      {run && (
        <div className="topbar-actions">
          {run.owned && finished && <DeleteRun runId={run.id} dataDeleted={run.dataDeletedAt !== null} />}
          <button className="btn" type="button" onClick={() => setSharing(true)}>
            <Icon name="link" />
            <span className="btn-label">Share</span>
          </button>
        </div>
      )}
    </div>
  );
  return (
    <Shell topbar={topbar} label="Evaluation report">
      {error && (
        <div className="empty-state">
          <div className="es-title">{error}</div>
        </div>
      )}
      {run?.status === "failed" && run.summary === null && (
        <div className="empty-state">
          <div className="es-title">This run failed: {run.error ?? "unknown error"}</div>
        </div>
      )}
      {run && finished && <Report run={run} presets={presets} title={title} reveal={reveal} />}
      {run && live && <Progress run={run} presets={presets} onDone={load} />}
      {run && sharing && (
        <ShareDialog
          runId={run.id}
          shareId={run.shareId}
          visibility={run.visibility}
          shareContent={run.shareContent}
          owned={run.owned}
          onClose={() => setSharing(false)}
          onChange={(c) => {
            setRun({ ...run, ...c });
            if (c.shareId !== run.shareId) history.replaceState(null, "", `/r/${c.shareId}`);
          }}
        />
      )}
    </Shell>
  );
};
