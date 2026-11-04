import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CellDone, currentUser, type Run } from "./api.ts";
import { Icon } from "./ax/Icon.tsx";
import { ContinueRun } from "./ContinueRun.tsx";
import { DeleteRun } from "./DeleteRun.tsx";
import { Go, Shell } from "./Nav.tsx";
import { Report } from "./Report.tsx";
import { ShareDialog } from "./Share.tsx";

export const runTitle = (run: Run) => {
  if (run.title) return run.title;
  const names = run.documents.map((d) => d.filename.replace(/\.[^.]+$/, ""));
  if (names.length <= 2) return names.join(" and ");
  return `${names.length} documents`;
};

/** The load state while a run is in flight: live counts from the run's event socket, and Continue for the owner. */
const Progress = ({ run, onDone }: { readonly run: Run; readonly onDone: () => void }) => {
  const [cells, setCells] = useState<ReadonlyMap<string, CellDone>>(new Map());
  const [judged, setJudged] = useState(0);
  const [slow, setSlow] = useState(false);
  const pages = run.documents.reduce((n, d) => n + d.pages.length, 0);

  useEffect(() => {
    const key = (c: CellDone) => `${c.presetId}:${c.pageId}`;
    return api.events(run.id, (event) => {
      if (event.type === "progress") {
        setCells(new Map(event.cells.map((c) => [key(c), c])));
        setJudged(event.done);
      } else if (event.type === "parse_done") setCells((m) => new Map(m).set(key(event), event));
      else if (event.type === "page_done") setJudged(event.done);
      else if (event.type === "run_done") onDone();
    });
  }, [run.id, onDone]);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, []);

  const total = pages * run.presetIds.length;
  const parsed = cells.size;
  const failed = [...cells.values()].filter((c) => !c.ok).length;
  const phase = pages === 0 ? 0 : parsed < total ? 1 : judged < pages ? 2 : 3;
  const lines = [
    "Preparing pages…",
    `Parsing pages… ${total === 0 ? 0 : Math.floor((parsed / total) * 100)}%`,
    `Judging parses… ${judged} of ${pages} pages`,
    "Preparing results…",
  ];
  const user = currentUser();
  return (
    <div className={`load-state has-acts${slow ? " is-slow" : ""}`}>
      <div className="ls-group">
        <span className="ls-icon">
          <Icon name="scan-text" />
        </span>
        <span className="ls-title">{runTitle(run)}</span>
        <span className="ls-status">
          {lines.map((l, i) => (
            <span key={l.replace(/[\d%]+/g, "")} className={`ls-line${i === phase ? " is-on" : ""}`}>
              {l}
            </span>
          ))}
        </span>
        <span className="ls-meta">
          {parsed} of {total} parses{failed > 0 && ` · ${failed} failed`}
        </span>
        <span className="ls-meta">
          {user ? `You can close this tab. We'll email ${user} when the report is ready.` : "You can close this tab."}
        </span>
        {run.owned && pages > 0 && (
          <span className="ls-acts">
            <ContinueRun runId={run.id} skip={pages - judged} onDone={onDone} />
          </span>
        )}
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
      {run && live && <Progress run={run} onDone={load} />}
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
