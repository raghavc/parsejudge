import { useState } from "react";
import { signIn } from "./api.ts";

/** Sign-in gate. Placeholder until email links land: it records the email locally (AUTH_MODE "dev"). */
export const SignIn = ({ onDone, onCancel }: { readonly onDone: () => void; readonly onCancel: () => void }) => {
  const [email, setEmail] = useState("");
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  return (
    <div
      className="modal-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,10,10,0.32)",
        display: "grid",
        placeItems: "center",
        zIndex: 10,
      }}
    >
      <form
        className="modal"
        style={{ background: "#fff", width: 440, padding: 40, borderRadius: 6, display: "grid", gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          signIn(email);
          onDone();
        }}
      >
        <div style={{ fontSize: 24, fontWeight: 500 }}>Sign in to run an evaluation</div>
        <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
          Hosted runs are free. We use your email to send the report link and to limit usage.
        </div>
        <input
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ height: 44, padding: "0 14px", border: "1px solid var(--line)", borderRadius: 4 }}
          // biome-ignore lint/a11y/noAutofocus: the dialog exists only to take this field.
          autoFocus
        />
        <button type="submit" className="btn primary" disabled={!valid} style={{ height: 44, justifyContent: "center" }}>
          Continue with email
        </button>
        <button type="button" className="btn" onClick={onCancel} style={{ height: 44, justifyContent: "center" }}>
          Cancel
        </button>
        <div style={{ color: "var(--faint)", fontSize: 12, lineHeight: "18px" }}>
          By continuing you agree that ParseJudge keeps the documents you upload and the results, and may publish them by share
          link.
        </div>
      </form>
    </div>
  );
};
