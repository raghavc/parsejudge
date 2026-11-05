import { useState } from "react";
import { api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

const option = { height: 44, justifyContent: "center" } as const;

/** Owner-only: skip the pages that have not finished and write the report from the rest. */
export const ContinueRun = ({
  runId,
  skip,
  onDone,
}: {
  readonly runId: string;
  readonly skip: number;
  readonly onDone: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    setBusy(true);
    setError(null);
    api.continueRun(runId).then(onDone, (e: unknown) => {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        Continue
      </button>
      {open && (
        <Dialog title="Continue without unfinished pages" onClose={() => busy || setOpen(false)}>
          <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
            {skip === 1 ? "1 page" : `${skip} pages`} will be skipped. The report covers the pages that finished.
          </div>
          <button type="button" className="btn primary" disabled={busy} style={option} onClick={confirm}>
            Skip {skip === 1 ? "1 page" : `${skip} pages`} and continue
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
