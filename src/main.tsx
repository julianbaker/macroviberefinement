import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MobileGate } from "./MobileGate";
import "./styles.css";

// Match the CSS breakpoint. Evaluated once at load — no live resize switching.
const isMobile = window.innerWidth <= 980;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isMobile ? <MobileGate /> : <App />}
  </StrictMode>,
);
