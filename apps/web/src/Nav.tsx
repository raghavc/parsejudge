import { navigate } from "./router.ts";

export const Nav = ({ user }: { readonly user?: string | null }) => (
  <header
    style={{
      alignItems: "center",
      borderBottom: "1px solid var(--rule)",
      display: "flex",
      justifyContent: "space-between",
      padding: "28px var(--gutter)",
    }}
  >
    <button
      type="button"
      onClick={() => navigate("/")}
      style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: "20px" }}
    >
      Parse Judge
    </button>
    <nav
      style={{
        alignItems: "center",
        display: "flex",
        gap: 28,
        fontSize: 14,
        minWidth: 0,
        lineHeight: "18px",
        color: "var(--muted)",
      }}
    >
      <a className="wide-only" href="https://github.com/reductoai/parsejudge/blob/main/docs/DESIGN.md">
        Methodology
      </a>
      <span className="wide-only">Leaderboard</span>
      <a href="https://github.com/reductoai/parsejudge">Source</a>
      <span style={{ color: "var(--ink)" }}>{user ?? "Sign in"}</span>
    </nav>
  </header>
);
