import { useEffect, useState } from "react";
import { type AccountInfo, type Agent, api, auth, currentUser, type RunListItem, setUser } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { Nav } from "./Nav.tsx";
import { navigate } from "./router.ts";

const row = {
  alignItems: "center",
  borderTop: "1px solid var(--line)",
  display: "flex",
  flexWrap: "wrap",
  gap: 24,
  justifyContent: "space-between",
  padding: "24px 0",
} as const;

export const Account = () => {
  const user = currentUser();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [runs, setRuns] = useState<ReadonlyArray<RunListItem> | null>(null);
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [agents, setAgents] = useState<ReadonlyArray<Agent> | null>(null);
  useEffect(() => {
    if (user) api.agents().then(setAgents, () => setAgents([]));
  }, [user]);
  const disconnect = async (agent: Agent) => {
    setError(null);
    try {
      await api.disconnectAgent(agent.id);
      setAgents((list) => list?.filter((a) => a.id !== agent.id) ?? null);
    } catch {
      setError(`Could not disconnect ${agent.name}.`);
    }
  };
  useEffect(() => {
    if (user) api.account().then(setInfo, () => setInfo(null));
  }, [user]);
  const toggleNotify = () => {
    if (info === null) return;
    api.setNotify(!info.notifyOnDone).then(setInfo, (e: unknown) => setError(String(e)));
  };
  useEffect(() => {
    if (confirm) api.runs().then(setRuns, () => setRuns([]));
  }, [confirm]);
  const leave = () => {
    setUser(null);
    navigate("/");
  };
  const signOut = () => {
    auth.signOut().finally(leave);
  };
  const removeAll = () => {
    setBusy(true);
    setError(null);
    api.deleteAccount().then(leave, (e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return (
    <div className="stagger">
      <Nav user={user} />
      <section style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 880, padding: "72px var(--gutter) 0" }}>
        <div className="eyebrow">Account</div>
        <div style={{ fontSize: "clamp(32px, 4.5vw, 48px)", fontWeight: 300, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
          {user ?? "Not signed in"}
        </div>
      </section>
      {user && (
        <section style={{ maxWidth: 880, padding: "48px var(--gutter) 72px" }}>
          <div style={row}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 520 }}>
              <div style={{ fontSize: 15 }}>Email me when a report is ready</div>
              <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>
                One email per run, with the scores and a link. Also sent if a run fails.
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={info?.notifyOnDone ?? false}
              aria-label="Email me when a report is ready"
              className={`switch${info?.notifyOnDone ? " on" : ""}`}
              disabled={info === null}
              onClick={toggleNotify}
            />
          </div>
          <div style={{ ...row, alignItems: "flex-start", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 15 }}>Connected agents</div>
              <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>
                Agents connected through MCP at {location.origin}/mcp can do anything you can do here.
              </div>
            </div>
            {agents?.length === 0 && (
              <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>None connected.</div>
            )}
            {agents?.map((agent) => (
              <div
                key={agent.id}
                style={{ alignItems: "center", display: "flex", gap: 16, justifyContent: "space-between", width: "100%" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <div className="clip" style={{ fontSize: 15 }}>
                    {agent.name}
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>
                    Connected{" "}
                    {new Date(agent.connectedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </div>
                </div>
                <button type="button" className="btn" onClick={() => disconnect(agent)}>
                  Disconnect
                </button>
              </div>
            ))}
          </div>
          <div style={row}>
            <div style={{ fontSize: 15 }}>Sign out of this browser</div>
            <button type="button" className="btn" onClick={signOut}>
              Sign out
            </button>
          </div>
          <div style={row}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 520 }}>
              <div style={{ fontSize: 15 }}>Delete all my data</div>
              <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>
                Removes every document you uploaded, every run and report, and their share links.
              </div>
            </div>
            <button type="button" className="btn" style={{ color: "var(--bad)" }} onClick={() => setConfirm(true)}>
              Delete all data
            </button>
          </div>
        </section>
      )}
      {confirm && (
        <Dialog title="Delete all your data?" onClose={() => busy || setConfirm(false)}>
          <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
            This permanently deletes everything you've added to Parse Judge:
          </div>
          <div className="delete-counts">
            <div>
              <span>Runs and reports</span>
              <span>{runs?.length ?? "…"}</span>
            </div>
            <div>
              <span>Uploaded documents</span>
              <span>
                {runs === null
                  ? "…"
                  : `${runs.reduce((n, r) => n + (r.dataDeletedAt === null ? r.documents : 0), 0)} · ${runs.reduce((n, r) => n + (r.dataDeletedAt === null ? r.pages : 0), 0)} pages`}
              </span>
            </div>
            <div>
              <span>Share links that will stop working</span>
              <span>{runs?.length ?? "…"}</span>
            </div>
            {runs?.some((r) => r.status === "queued" || r.status === "running") && (
              <div style={{ color: "var(--bad)" }}>
                <span>Runs in progress, stopped now</span>
                <span>{runs.filter((r) => r.status === "queued" || r.status === "running").length}</span>
              </div>
            )}
          </div>
          <div style={{ color: "var(--muted)", fontSize: 13, lineHeight: "20px" }}>
            Your account stays, so you can still sign in. To delete runs one at a time, use the menu on each run instead.
          </div>
          <label style={{ display: "grid", fontSize: 13, gap: 8 }}>
            <span>
              Type <span className="mono">delete my data</span> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              style={{ border: "1px solid var(--ink)", borderRadius: 4, fontSize: 15, height: 44, padding: "0 12px" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary danger-fill"
              disabled={busy || typed.trim().toLowerCase() !== "delete my data"}
              onClick={removeAll}
            >
              Delete all data
            </button>
          </div>
          {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
        </Dialog>
      )}
    </div>
  );
};
