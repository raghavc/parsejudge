import { navigate } from "./router.ts";

export const Nav = ({ user }: { readonly user?: string | null }) => (
  <header
    style={{
      alignItems: "center",
      borderBottom: "1px solid var(--rule)",
      display: "flex",
      justifyContent: "space-between",
      padding: "28px 120px",
    }}
  >
    <button
      type="button"
      onClick={() => navigate("/")}
      style={{ fontSize: 16, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: "20px" }}
    >
      Parse Judge
    </button>
    <nav style={{ alignItems: "center", display: "flex", gap: 36, fontSize: 14, lineHeight: "18px", color: "var(--muted)" }}>
      <a href="https://github.com/reductoai/parsejudge/blob/main/docs/DESIGN.md">Methodology</a>
      <span>Leaderboard</span>
      <a href="https://github.com/reductoai/parsejudge">Source</a>
      <span style={{ color: "var(--ink)" }}>{user ?? "Sign in"}</span>
    </nav>
  </header>
);
