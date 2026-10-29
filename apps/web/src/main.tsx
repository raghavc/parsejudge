import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Account } from "./Account.tsx";
import { loadUser } from "./api.ts";
import { Landing } from "./Landing.tsx";
import { Methodology } from "./Methodology.tsx";
import { PageCompare } from "./PageCompare.tsx";
import { RunPage } from "./RunPage.tsx";
import { Runs } from "./Runs.tsx";
import { useRoute } from "./router.ts";
import { SignInLink } from "./SignIn.tsx";
import { SignInPage } from "./SignInPage.tsx";

const App = () => {
  const route = useRoute();
  if (route.name === "account") return <Account />;
  if (route.name === "runs") return <Runs />;
  if (route.name === "methodology") return <Methodology />;
  if (route.name === "signin") return <SignInPage next={route.next} />;
  if (route.name === "auth") return <SignInLink token={route.token} />;
  if (route.name === "run") return <RunPage shareId={route.shareId} />;
  if (route.name === "page") return <PageCompare shareId={route.shareId} pageId={route.pageId} view={route.view} />;
  return <Landing />;
};

const root = document.getElementById("root");
if (root)
  loadUser().finally(() =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
