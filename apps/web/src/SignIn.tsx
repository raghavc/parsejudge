import { useEffect, useRef, useState } from "react";
import { AUTH_CHANNEL, auth, currentUser, DRAFT_KEY, type DraftDocument, setUser } from "./api.ts";
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
  readonly onEmail: (email: string, turnstile: string | null) => Promise<void>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onCancel();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);

  const done = useRef(onDone);
  done.current = onDone;
  const checking = useRef(false);
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [turnstile, setTurnstile] = useState<string | null>(null);
  const widget = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const waiting = siteKey !== null && turnstile === null;

  useEffect(() => {
    auth.config().then(
      (c) => setSiteKey(c.turnstileSiteKey),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    const el = widget.current;
    if (siteKey === null || el === null) return;
    let cancelled = false;
    loadTurnstile().then(
      (ts) => {
        if (cancelled) return;
        widgetId.current = ts.render(el, {
          sitekey: siteKey,
          size: "flexible",
          appearance: "interaction-only",
          callback: (token: string) => setTurnstile(token),
          "expired-callback": () => setTurnstile(null),
        });
      },
      () => setError("Could not load the check that you are a person. Reload the page."),
    );
    return () => {
      cancelled = true;
      if (widgetId.current !== null) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = (event: MessageEvent<{ readonly email: string }>) => {
      setUser(event.data.email);
      done.current();
    };
    return () => channel.close();
  }, []);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await onEmail(email, turnstile);
      setSent(true);
    } catch (e) {
      setError(message(e));
    }
    // A Turnstile token works once.
    setTurnstile(null);
    if (widgetId.current !== null) window.turnstile?.reset(widgetId.current);
    setBusy(false);
  };
  const check = async (value: string) => {
    if (checking.current) return;
    checking.current = true;
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
    checking.current = false;
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a backdrop click closes the modal; Escape does the same from the keyboard.
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}
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
        style={{
          background: "#fff",
          width: "min(440px, calc(100vw - 24px))",
          padding: "clamp(20px, 6vw, 40px)",
          boxSizing: "border-box",
          borderRadius: 6,
          display: "grid",
          gap: 16,
        }}
        onSubmit={(e) => {
          e.preventDefault();
          if (sent) {
            if (code.length === 6) check(code);
          } else if (valid) send();
        }}
      >
        <div style={{ fontSize: 24, fontWeight: 500 }}>{sent ? "Check your email" : "Sign in to run an evaluation"}</div>
        <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
          {sent ? (
            `We sent a code to ${email}. Enter it here, or click the link in the email. Your files are kept either way.`
          ) : (
            <>
              By continuing you agree to the{" "}
              <a className="legal-link" href="/terms" target="_blank" rel="noopener">
                Terms of Service
              </a>{" "}
              and{" "}
              <a className="legal-link" href="/privacy" target="_blank" rel="noopener">
                Privacy Policy
              </a>
              .
            </>
          )}
        </div>
        {sent ? (
          <input
            key="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6-digit code"
            maxLength={6}
            value={code}
            readOnly={busy}
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
        <div ref={widget} />
        {error && (
          <div className="enter" style={{ color: "var(--bad)", fontSize: 13 }}>
            {error}
          </div>
        )}
        <button
          type="submit"
          className="btn primary"
          disabled={busy || (sent ? code.length !== 6 : !valid || waiting)}
          style={wide}
        >
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
        {sent && (
          <button type="button" className="btn" disabled={busy || waiting} onClick={send} style={{ justifySelf: "center" }}>
            Send a new email
          </button>
        )}
      </form>
    </div>
  );
};

type Turnstile = {
  readonly render: (el: HTMLElement, options: Record<string, unknown>) => string;
  readonly reset: (id: string) => void;
  readonly remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}
let turnstileScript: Promise<Turnstile> | null = null;
const loadTurnstile = () => {
  turnstileScript ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not load")));
    script.onerror = () => reject(new Error("Turnstile did not load"));
    document.head.appendChild(script);
  });
  return turnstileScript;
};

type LinkState =
  | { readonly step: "loading" }
  | { readonly step: "confirm"; readonly email: string; readonly documents: ReadonlyArray<DraftDocument> }
  | { readonly step: "signing-in" }
  | { readonly step: "error"; readonly error: string };

/**
 * The emailed link (/auth?token=…). Mail scanners open links, and anyone can send you a link to their own account,
 * so the page shows the account and its carried-over files and signs in only on a click. The browser that asked
 * for the email skips the question.
 */
export const SignInLink = ({ token }: { readonly token: string }) => {
  const [state, setState] = useState<LinkState>({ step: "loading" });
  const fail = (e: unknown) => {
    if (currentUser() !== null) {
      history.replaceState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    } else setState({ step: "error", error: message(e) });
  };
  const signIn = (discard: boolean) => {
    setState({ step: "signing-in" });
    auth.verify({ token, discard }).then(({ email, draft }) => {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      const channel = new BroadcastChannel(AUTH_CHANNEL);
      channel.postMessage({ email });
      channel.close();
      history.replaceState(null, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    }, fail);
  };
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    auth.link(token).then(({ email, documents, sameBrowser }) => {
      if (sameBrowser) signIn(false);
      else setState({ step: "confirm", email, documents });
    }, fail);
  });
  return (
    <div>
      <Nav user={null} />
      <section style={{ display: "grid", gap: 16, maxWidth: 560, padding: "112px var(--gutter)" }}>
        {state.step === "confirm" ? (
          <>
            <div style={{ fontSize: 24, fontWeight: 500, overflowWrap: "anywhere" }}>Continue as {state.email}?</div>
            {state.documents.length > 0 && (
              <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>
                These files were added before sign-in and will be in your account:
                <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                  {state.documents.slice(0, 10).map((d) => (
                    <li key={d.documentId} className="clip" style={{ color: "var(--ink)" }}>
                      {d.filename}
                    </li>
                  ))}
                  {state.documents.length > 10 && <li>and {state.documents.length - 10} more</li>}
                </ul>
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <button type="button" className="btn primary" onClick={() => signIn(false)} style={wide}>
                Continue
              </button>
              {state.documents.length > 0 && (
                <button type="button" className="btn" onClick={() => signIn(true)} style={wide}>
                  Continue without these files
                </button>
              )}
            </div>
            <div style={{ color: "var(--faint)", fontSize: 12, lineHeight: "18px" }}>
              If you did not ask to sign in to ParseJudge, close this page.
            </div>
          </>
        ) : (
          <div style={{ fontSize: 24, fontWeight: 500 }}>
            {state.step === "error" ? "Could not sign you in" : state.step === "signing-in" ? "Signing you in…" : "Loading…"}
          </div>
        )}
        {state.step === "error" && (
          <>
            <div style={{ color: "var(--muted)", fontSize: 14, lineHeight: "22px" }}>{state.error}</div>
            <a className="btn" href="/" style={{ justifySelf: "start" }}>
              Back to ParseJudge
            </a>
          </>
        )}
      </section>
    </div>
  );
};
