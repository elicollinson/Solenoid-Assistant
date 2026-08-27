import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AgentHome } from "./app/AgentHome";
import { registerServiceWorker } from "./pwa";
import "./kit/tokens.css";

// Production only, and after load. See ./pwa.ts for why.
registerServiceWorker();

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <AgentHome />
  </StrictMode>,
);
