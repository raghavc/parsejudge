import type { ReactNode } from "react";

export const Dialog = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => (
  <div
    className="modal-backdrop"
    style={{ background: "rgba(10,10,10,0.32)", display: "grid", inset: 0, placeItems: "center", position: "fixed", zIndex: 10 }}
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
