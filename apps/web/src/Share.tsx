import { useState } from "react";
import { api, type Visibility } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Dialog } from "./Dialog.tsx";

const OPTIONS: ReadonlyArray<{ readonly value: Visibility; readonly label: string; readonly note: string }> = [
  { value: "link", label: "Anyone with the link", note: "They can open the report without signing in." },
  { value: "private", label: "Only you", note: "The link stops working for everyone else. You can turn it back on." },
];

export const visibilityLabel = (visibility: Visibility, shareContent: boolean) =>
  visibility === "private" ? "Only you" : shareContent ? "Anyone with the link" : "Anyone with the link, scores only";

type Sharing = { shareId: string; visibility: Visibility; shareContent: boolean };

/** Who can open a run's share link, the link itself, and a new link that turns off the old one. */
export const ShareDialog = ({
  runId,
  shareId: initialShareId,
  visibility: initialVisibility,
  shareContent: initialShareContent,
  owned,
  onClose,
  onChange,
}: {
  readonly runId: string;
  readonly shareId: string;
  readonly visibility: Visibility;
  readonly shareContent: boolean;
  readonly owned: boolean;
  readonly onClose: () => void;
  readonly onChange?: (change: Sharing) => void;
}) => {
  const [visibility, setVisibility] = useState(initialVisibility);
  const [shareContent, setShareContent] = useState(initialShareContent);
  const [shareId, setShareId] = useState(initialShareId);
  const [error, setError] = useState<string | null>(null);
  const url = `${location.origin}/r/${shareId}`;
  const choose = (next: Visibility) => {
    setError(null);
    api.setVisibility(runId, next).then(
      () => {
        setVisibility(next);
        onChange?.({ shareId, visibility: next, shareContent });
      },
      (e: unknown) => setError(String(e)),
    );
  };
  const rotate = () => {
    setError(null);
    api.rotateLink(runId).then(
      (r) => {
        setShareId(r.shareId);
        onChange?.({ shareId: r.shareId, visibility, shareContent });
      },
      (e: unknown) => setError(String(e)),
    );
  };
  const toggleContent = () => {
    const next = !shareContent;
    setError(null);
    api.setShareContent(runId, next).then(
      () => {
        setShareContent(next);
        onChange?.({ shareId, visibility, shareContent: next });
      },
      (e: unknown) => setError(String(e)),
    );
  };
  return (
    <Dialog title="Share this report">
      {owned && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="eyebrow">Who can open</div>
          {OPTIONS.map((o) => (
            <label key={o.value} style={{ alignItems: "start", cursor: "pointer", display: "flex", gap: 10 }}>
              <input
                type="radio"
                name="visibility"
                checked={visibility === o.value}
                onChange={() => choose(o.value)}
                style={{ marginTop: 3 }}
              />
              <span style={{ display: "grid", gap: 2 }}>
                <span style={{ fontSize: 15 }}>{o.label}</span>
                <span style={{ color: "var(--muted)", fontSize: 13 }}>{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {owned && visibility === "link" && (
        <div style={{ alignItems: "center", display: "flex", gap: 16, justifyContent: "space-between" }}>
          <span style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 15 }}>Include document content</span>
            <span style={{ color: "var(--muted)", fontSize: 13 }}>
              {shareContent
                ? "They can open every page: the images, each parser's output and the judge's notes."
                : "They see only the scores, latency and cost. Pages, images and parser output stay private."}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={shareContent}
            aria-label="Include document content"
            className={`switch${shareContent ? " on" : ""}`}
            onClick={toggleContent}
            style={{ flexShrink: 0 }}
          />
        </div>
      )}
      <div
        style={{
          alignItems: "center",
          border: "1px solid var(--line)",
          borderRadius: 4,
          display: "flex",
          gap: 12,
          justifyContent: "space-between",
          padding: "10px 12px",
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {url}
        </span>
        <CopyButton text={url} label="Copy" />
      </div>
      {owned && (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          Sent the link to the wrong person?{" "}
          <button type="button" className="u" onClick={rotate} style={{ fontSize: 13 }}>
            Make a new link
          </button>{" "}
          and the old one stops working.
        </div>
      )}
      {error && <div style={{ color: "var(--bad)", fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
};
