import { useState } from "react";
import { api, currentUser, signOut } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { Nav } from "./Nav.tsx";
import { navigate } from "./router.ts";

const row = {
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
  const leave = () => {
    signOut();
    navigate("/");
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
            <div style={{ fontSize: 15 }}>Sign out of this browser</div>
            <button type="button" className="btn" onClick={leave}>
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
        <Dialog title="Delete all your data">
          <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
            Every document, run, report and share link for {user} is deleted. This cannot be undone.
          </div>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            style={{ background: "var(--bad)", borderColor: "var(--bad)", height: 44, justifyContent: "center" }}
            onClick={removeAll}
          >
            Delete everything
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            style={{ height: 44, justifyContent: "center" }}
            onClick={() => setConfirm(false)}
          >
            Cancel
          </button>
          {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
        </Dialog>
      )}
    </div>
  );
};
