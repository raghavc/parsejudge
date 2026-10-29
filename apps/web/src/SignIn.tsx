import { useEffect, useState } from "react";
import { AUTH_CHANNEL, auth, DRAFT_KEY, setUser } from "./api.ts";
import { Nav } from "./Nav.tsx";

const field = { height: 44, padding: "0 14px", border: "1px solid var(--line)", borderRadius: 4 } as const;
const wide = { height: 44, justifyContent: "center" } as const;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Sign-in gate: emails a code and a link. Files added before sign-in upload right after the email is sent
 * (`onEmail`), so the link restores them in any tab or browser. The link tab also signs this tab in.
 */
export const SignIn = ({
  onEmail,
  onDone,
  onCancel,
}: {
  readonly onEmail: (email: string) => Promise<void>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  useEffect(() => {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ readonly email: string }>) => {
      setUser(event.data.email);
      onDone();
    };
    return () => channel.close();
  }, [onDone]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await onEmail(email);
      setSent(true);
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  };
  const check = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      await auth.verify({ code: value });
      onDone();
    } catch (e) {
      setError(message(e));
      setCode("");
      setBusy(false);
    }
  };
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
          if (sent) {
            if (code.length === 6) check(code);
          } else if (valid) send();
        }}
      >
        <div style={{ fontSize: 24, fontWeight: 500 }}>{sent ? "Check your email" : "Sign in to run an evaluation"}</div>
        <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
          {sent
            ? `We sent a code to ${email}. Enter it here, or click the link in the email. Your files are kept either way.`
            : "Hosted runs are free. We email you a sign-in code and the report link."}
        </div>
        {sent ? (
          <input
            key="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            maxLength={6}
            value={code}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value.replace(/\D/g, "");
              setCode(value);
              if (value.length === 6) check(value);
            }}
            style={{ ...field, fontSize: 18, letterSpacing: "0.3em" }}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists only to take this field.
            autoFocus
          />
        ) : (
          <input
            key="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={field}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists only to take this field.
            autoFocus
          />
        )}
        {error && (
          <div className="enter" style={{ color: "var(--bad)", fontSize: 13 }}>
            {error}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || (sent ? code.length !== 6 : !valid)} style={wide}>
          {sent ? "Sign in" : busy ? "Sending…" : "Email me a code"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!sent) return onCancel();
            setSent(false);
            setCode("");
            setError(null);
          }}
          style={wide}
        >
          {sent ? "Use a different email" : "Cancel"}
        </button>
        <div style={{ color: "var(--faint)", fontSize: 12, lineHeight: "18px" }}>
          By continuing you agree that ParseJudge keeps the documents you upload and the results, and may publish them by share
          link.
        </div>
      </form>
    </div>
  );
};

const verifying = new Map<string, ReturnType<typeof auth.verify>>();

/** The emailed link (/auth?token=…): signs in, then opens the landing page with the files uploaded before sign-in. */
export const SignInLink = ({ token }: { readonly token: string }) => {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const result = verifying.get(token) ?? auth.verify({ token });
    verifying.set(token, result);
    result.then(
      ({ email, draft }) => {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        const channel = new BroadcastChannel(AUTH_CHANNEL);
        channel.postMessage({ email });
        channel.close();
        history.replaceState(null, "", "/");
        dispatchEvent(new PopStateEvent("popstate"));
      },
      (e: unknown) => setError(message(e)),
    );
  }, [token]);
  return (
    <div>
      <Nav user={null} />
      <section style={{ display: "grid", gap: 16, maxWidth: 560, padding: "112px var(--gutter)" }}>
        <div style={{ fontSize: 24, fontWeight: 500 }}>{error === null ? "Signing you in…" : "Could not sign you in"}</div>
        {error !== null && (
          <>
            <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>{error}</div>
            <a className="btn" href="/" style={{ justifySelf: "start" }}>
              Back to ParseJudge
            </a>
          </>
        )}
      </section>
    </div>
  );
};
