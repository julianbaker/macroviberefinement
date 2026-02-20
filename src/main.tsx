import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ArchiveView } from "./ArchiveView";
import "./styles.css";

type Route =
  | { view: "refine" }
  | { view: "archive" }
  | { view: "archive-bin"; binCode: string };

function Router() {
  // State-based routing — the URL hash never changes, so refresh always
  // returns to the gate/refine view. No hashchange listener needed.
  const [route, setRoute] = useState<Route>({ view: "refine" });
  const navigate = useCallback((r: Route) => setRoute(r), []);

  if (route.view === "archive") {
    return <ArchiveView navigate={navigate} />;
  }
  if (route.view === "archive-bin") {
    return <ArchiveView binCode={route.binCode} navigate={navigate} />;
  }
  return <App navigate={navigate} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
