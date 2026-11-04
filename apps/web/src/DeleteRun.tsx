import { useState } from "react";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { navigate } from "./router.ts";

const option = { height: 44, justifyContent: "center" } as const;

/** Owner-only: delete a run's documents (the report stays) or the documents and the report. */
export const DeleteRun = ({ runId, dataDeleted }: { readonly runId: string; readonly dataDeleted: boolean }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = (scope: "data" | "report") => {
    setBusy(true);
    setError(null);
    api.deleteRun(runId, scope).then(
      () => (scope === "report" ? navigate("/") : location.reload()),
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Delete
      </button>
      {open && (
        <Dialog title="Delete this run" onClose={() => busy || setOpen(false)}>
          <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
            Deleting documents removes the uploaded files, page images, parser outputs and judge notes. The scores and charts stay
            on this report. Deleting the report also removes the report and its share link. Both cannot be undone.
          </div>
          {!dataDeleted && (
            <button type="button" className="btn" disabled={busy} style={option} onClick={() => remove("data")}>
              Delete documents, keep report
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            style={{ ...option, background: "var(--bad)", borderColor: "var(--bad)" }}
            onClick={() => remove("report")}
          >
            Delete documents and report
          </button>
          <button type="button" className="btn" disabled={busy} style={option} onClick={() => setOpen(false)}>
            Cancel
          </button>
          {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
        </Dialog>
      )}
    </>
  );
};
