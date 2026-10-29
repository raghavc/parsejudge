import { navigate } from "./router.ts";

export const Nav = ({ user, active }: { readonly user?: string | null; readonly active?: "runs" | "methodology" }) => (
  <header
    style={{
      alignItems: "center",
      borderBottom: "1px solid var(--rule)",
      display: "flex",
      gap: 20,
      justifyContent: "space-between",
      padding: "28px var(--gutter)",
    }}
  >
    <button
      type="button"
      onClick={() => navigate("/")}
      style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: "20px", whiteSpace: "nowrap" }}
    >
      Parse Judge
    </button>
    <nav
      style={{
        alignItems: "center",
        display: "flex",
        gap: "clamp(14px, 2.5vw, 28px)",
        fontSize: 14,
        minWidth: 0,
        lineHeight: "18px",
        color: "var(--muted)",
      }}
    >
      {user && (
        <button type="button" style={{ color: active === "runs" ? "var(--ink)" : undefined }} onClick={() => navigate("/runs")}>
          Runs
        </button>
      )}
      <a
        className="wide-only"
        href="/methodology"
        style={{ color: active === "methodology" ? "var(--ink)" : undefined }}
        onClick={(e) => {
          e.preventDefault();
          navigate("/methodology");
        }}
      >
        Methodology
      </a>
      <a href="https://github.com/reductoai/parsejudge">Source</a>
      {user ? (
        <button
          type="button"
          className="clip"
          style={{ color: "var(--ink)", maxWidth: 220 }}
          onClick={() => navigate("/account")}
        >
          {user}
        </button>
      ) : (
        <span style={{ color: "var(--ink)" }}>Sign in</span>
      )}
    </nav>
  </header>
);
