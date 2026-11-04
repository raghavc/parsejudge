import { type ReactNode, useEffect } from "react";

/** A modal. A click on the backdrop or Escape calls `onClose`. */
export const Dialog = ({
  title,
  children,
  onClose,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click closes the modal; Escape does the same from the keyboard.
    <div
      className="modal-backdrop open"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        background: "rgba(10,10,10,0.32)",
        display: "grid",
        inset: 0,
        placeItems: "center",
        position: "fixed",
        zIndex: 10,
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        style={{
          background: "#fff",
          borderRadius: 6,
          display: "grid",
          gap: 16,
          gridTemplateColumns: "minmax(0, 1fr)",
          maxWidth: "calc(100vw - 32px)",
          padding: 32,
          width: 440,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 500 }}>{title}</div>
        {children}
      </div>
    </div>
  );
};
