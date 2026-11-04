import { type ReactNode, useEffect } from "react";
import { Icon } from "./ax/Icon.tsx";

/** A modal in the Almanac chrome: title + close, a body, and an optional footer. A click on the backdrop or Escape calls `onClose`. */
export const Dialog = ({
  title,
  children,
  foot,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly foot?: ReactNode;
  readonly onClose: () => void;
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="pjx">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click closes the modal; Escape does the same from the keyboard. */}
      <div className="modal-backdrop open" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
          <div className="m-head">
            <div className="m-title-wrap">
              <h2 className="m-title">{title}</h2>
            </div>
            <button type="button" className="m-close" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
          <div className="m-body">{children}</div>
          {foot && <div className="m-foot">{foot}</div>}
        </div>
      </div>
    </div>
  );
};
