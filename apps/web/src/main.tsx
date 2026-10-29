import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Account } from "./Account.tsx";
import { Landing } from "./Landing.tsx";
import { PageCompare } from "./PageCompare.tsx";
import { RunPage } from "./RunPage.tsx";
import { useRoute } from "./router.ts";

const App = () => {
  const route = useRoute();
  if (route.name === "account") return <Account />;
  if (route.name === "run") return <RunPage shareId={route.shareId} />;
  if (route.name === "page") return <PageCompare shareId={route.shareId} pageId={route.pageId} view={route.view} />;
  return <Landing />;
};

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
