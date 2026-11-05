import { useState } from "react";
import { api, type Visibility } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Dialog } from "./Dialog.tsx";

const OPTIONS: ReadonlyArray<{ readonly value: Visibility; readonly label: string; readonly note: string }> = [
  { value: "link", label: "Anyone with the link", note: "No sign-in needed." },
  { value: "private", label: "Only you", note: "The link stops working for everyone else until you turn it back on." },
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
  path = "",
  onClose,
  onChange,
}: {
  readonly runId: string;
  readonly shareId: string;
  readonly visibility: Visibility;
  readonly shareContent: boolean;
  readonly owned: boolean;
  /** What the copied link opens, after `/r/<shareId>`; the run's report when empty. */
  readonly path?: string;
  readonly onClose: () => void;
  readonly onChange?: (change: Sharing) => void;
}) => {
  const [visibility, setVisibility] = useState(initialVisibility);
  const [shareContent, setShareContent] = useState(initialShareContent);
  const [shareId, setShareId] = useState(initialShareId);
  const [error, setError] = useState<string | null>(null);
  const url = `${location.origin}/r/${shareId}${path}`;
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
    <Dialog
      title="Share"
      onClose={onClose}
      foot={
        <>
          <span className="cost-wrap" />
          <button type="button" className="btn primary" onClick={onClose}>
            <span className="btn-label">Done</span>
          </button>
        </>
      }
    >
      {owned && (
        <div className="sh-field">
          <span className="field-label">Who can open</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a fieldset breaks the .mode-seg flex layout; the group role names the segment. */}
          <div className="mode-seg lg sh-seg" role="group" aria-label="Who can open">
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={visibility === o.value}
                className={`mode-btn${visibility === o.value ? " active" : ""}`}
                onClick={() => visibility === o.value || choose(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <span className="sh-note">{OPTIONS.find((o) => o.value === visibility)?.note}</span>
        </div>
      )}
      {owned && visibility === "link" && (
        <div className="sh-row">
          <span className="sh-text">
            <span className="sh-label">Include document content</span>
            <span className="sh-note">
              {shareContent ? "Pages, parser output and judge notes are visible." : "Only scores, latency and cost are visible."}
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={shareContent}
            aria-label="Include document content"
            className={`switch${shareContent ? " on" : ""}`}
            onClick={toggleContent}
          />
        </div>
      )}
      <div className="sh-field">
        <span className="field-label">Link</span>
        <div className="sh-link">
          <span className="sh-url">{url}</span>
          <CopyButton text={url} label="Copy link" />
        </div>
        {owned && (
          <span className="sh-note">
            Sent it to the wrong person?{" "}
            <button type="button" className="dl-act" onClick={rotate}>
              Make a new link
            </button>
            . The old one stops working.
          </span>
        )}
      </div>
      {error && <span className="sh-note sh-err">{error}</span>}
    </Dialog>
  );
};
