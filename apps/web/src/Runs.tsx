import { useEffect, useMemo, useState } from "react";
import { api, currentUser, type Preset, type RunListItem } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { Nav } from "./Nav.tsx";
import { ShareDialog, visibilityLabel } from "./Share.tsx";
import { shortName } from "./names.ts";
import { navigate } from "./router.ts";

const started = (ms: number) => {
  const date = new Date(ms);
  const today = new Date();
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
};

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const shareUrl = (run: RunListItem) => `${location.origin}/r/${run.shareId}`;
const inProgress = (run: RunListItem) => run.status === "queued" || run.status === "running";

const Status = ({ run }: { readonly run: RunListItem }) => {
  if (inProgress(run)) {
    const percent = run.pages === 0 ? 0 : Math.round((run.judged / run.pages) * 100);
    return (
      <div style={{ display: "grid", gap: 6, maxWidth: 104 }}>
        <span style={{ color: "var(--accent)" }}>Running · {percent}%</span>
        <div style={{ background: "var(--line)", height: 2 }}>
          <div style={{ background: "var(--accent)", height: 2, width: `${percent}%` }} />
        </div>
      </div>
    );
  }
  if (run.status === "failed") return <span style={{ color: "var(--bad)" }}>Failed</span>;
  return <span>{run.dataDeletedAt === null ? "Complete" : "Complete · documents deleted"}</span>;
};

export const Runs = () => {
  const user = currentUser();
  const [runs, setRuns] = useState<ReadonlyArray<RunListItem> | null>(null);
  const [presets, setPresets] = useState<ReadonlyArray<Preset>>([]);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [sharing, setSharing] = useState<RunListItem | null>(null);
  const [renaming, setRenaming] = useState<RunListItem | null>(null);
  const [deleting, setDeleting] = useState<RunListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const load = () => setVersion((v) => v + 1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version reloads the list.
  useEffect(() => {
    if (user === null) return;
    api.runs().then(setRuns, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [user, version]);
  useEffect(() => {
    api.presets().then(setPresets, () => undefined);
  }, []);
  useEffect(() => {
    if (!runs?.some(inProgress)) return;
    const timer = setTimeout(() => setVersion((v) => v + 1), 5000);
    return () => clearTimeout(timer);
  }, [runs]);
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    addEventListener("click", close);
    return () => removeEventListener("click", close);
  }, [menu]);
  const provider = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    return preset === undefined ? presetId : shortName(preset.provider);
  };
  const shown = useMemo(
    () => (runs ?? []).filter((run) => (run.title ?? "Untitled run").toLowerCase().includes(search.trim().toLowerCase())),
    [runs, search],
  );
  const runAgain = async (item: RunListItem) => {
    setError(null);
    try {
      const run = await api.run(item.id);
      const hosted = run.presetIds.filter((id) => presets.find((p) => p.id === id)?.hosted);
      const created = await api.createRun({
        documentIds: run.documents.map((d) => d.id),
        presetIds: hosted,
        title: run.title ?? undefined,
        credentials: {},
      });
      navigate(`/r/${created.shareId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  if (user === null) {
    return (
      <div className="stagger">
        <Nav user={user} />
        <section style={{ padding: "72px var(--gutter)" }}>Sign in to see your runs.</section>
      </div>
    );
  }
  const pages = (runs ?? []).reduce((sum, run) => sum + run.pages, 0);
  return (
    <div className="stagger">
      <Nav user={user} active="runs" />
      <section
        style={{
          alignItems: "flex-end",
          display: "flex",
          flexWrap: "wrap",
          gap: 24,
          justifyContent: "space-between",
          padding: "56px var(--gutter) 24px",
        }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <h1
            style={{
              fontSize: "clamp(32px, 4.5vw, 44px)",
              fontWeight: 300,
              letterSpacing: "-0.03em",
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            Your runs
          </h1>
          <div style={{ color: "var(--muted)", fontSize: 14 }}>
            {runs === null ? "Loading…" : `${plural(runs.length, "run")} · ${plural(pages, "page")}`}
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <input
            className="search"
            type="search"
            placeholder="Search runs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ border: "1px solid var(--line)", borderRadius: 4, height: 40, padding: "0 12px", width: 220 }}
          />
          <button type="button" className="btn primary" style={{ height: 40 }} onClick={() => navigate("/")}>
            New evaluation
          </button>
        </div>
      </section>
      {error && <div style={{ color: "var(--bad)", fontSize: 13, padding: "0 var(--gutter) 12px" }}>{error}</div>}
      <section style={{ padding: "0 var(--gutter) 72px" }}>
        <table className="runs-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Started</th>
              <th>Status</th>
              <th>Top mean score</th>
              <th>Who can open</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {shown.map((run) => (
              <tr key={run.id} onClick={() => navigate(`/r/${run.shareId}`)}>
                <td>
                  <div className="clip" style={{ fontSize: 15, maxWidth: 420 }}>
                    {run.title ?? "Untitled run"}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 13 }}>
                    {plural(run.documents, "document")} · {plural(run.pages, "page")} ·{" "}
                    {plural(run.presetIds.length, "provider mode")}
                  </div>
                </td>
                <td>{started(run.createdAt)}</td>
                <td>
                  <Status run={run} />
                </td>
                <td>{run.top === null ? "—" : `${provider(run.top.presetId)} · ${run.top.meanScore.toFixed(1)}`}</td>
                <td>{visibilityLabel(run.visibility)}</td>
                <td style={{ position: "relative", textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn"
                    aria-label="Run actions"
                    style={{ border: 0, height: 32, padding: "0 8px" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenu(menu === run.id ? null : run.id);
                    }}
                  >
                    ···
                  </button>
                  {menu === run.id && (
                    <div
                      className="popover run-menu"
                      role="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenu(null);
                      }}
                      onKeyDown={(e) => e.key === "Escape" && setMenu(null)}
                    >
                      <button type="button" onClick={() => navigate(`/r/${run.shareId}`)}>
                        Open report
                      </button>
                      <button type="button" onClick={() => navigator.clipboard.writeText(shareUrl(run))}>
                        Copy share link
                      </button>
                      <button type="button" onClick={() => setSharing(run)}>
                        Sharing settings
                      </button>
                      <button type="button" onClick={() => setRenaming(run)}>
                        Rename
                      </button>
                      <button type="button" disabled={run.dataDeletedAt !== null} onClick={() => runAgain(run)}>
                        Run again
                      </button>
                      <button type="button" className="danger" onClick={() => setDeleting(run)}>
                        Delete run
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {runs !== null && shown.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--muted)" }}>
                  {runs.length === 0 ? "No runs yet." : "No runs match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      {sharing && (
        <ShareDialog
          runId={sharing.id}
          shareId={sharing.shareId}
          visibility={sharing.visibility}
          owned
          onClose={() => setSharing(null)}
          onChange={load}
        />
      )}
      {renaming && <Rename run={renaming} onClose={() => setRenaming(null)} onDone={load} />}
      {deleting && <DeleteDialog run={deleting} onClose={() => setDeleting(null)} onDone={load} />}
    </div>
  );
};

const Rename = ({
  run,
  onClose,
  onDone,
}: {
  readonly run: RunListItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) => {
  const [title, setTitle] = useState(run.title ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = () =>
    api.rename(run.id, title).then(
      () => {
        onDone();
        onClose();
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  return (
    <Dialog title="Rename run">
      <input
        value={title}
        maxLength={80}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        style={{ border: "1px solid var(--ink)", borderRadius: 4, fontSize: 15, height: 44, padding: "0 12px" }}
      />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={title.trim() === ""} onClick={save}>
          Save
        </button>
      </div>
      {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
    </Dialog>
  );
};

const DeleteDialog = ({
  run,
  onClose,
  onDone,
}: {
  readonly run: RunListItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setBusy(true);
    api.deleteRun(run.id, "report").then(
      () => {
        onDone();
        onClose();
      },
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <Dialog title={`Delete "${run.title ?? "Untitled run"}"?`}>
      <div style={{ color: "var(--muted)", fontSize: 14 }}>This permanently deletes:</div>
      <ul className="delete-list">
        {run.dataDeletedAt === null && (
          <li>
            The {plural(run.documents, "document")} you uploaded ({plural(run.pages, "page")})
          </li>
        )}
        <li>Every provider output, score and judge note</li>
        <li>The report and its share link. Anyone who has the link will see "This run was deleted."</li>
      </ul>
      <div style={{ color: "var(--muted)", fontSize: 13 }}>This can't be undone.</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary danger-fill" disabled={busy} onClick={remove}>
          Delete run
        </button>
      </div>
      {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
    </Dialog>
  );
};
