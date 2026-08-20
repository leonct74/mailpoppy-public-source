// FIRST import, before anything else: on agentspoppy.com's sandboxed demo iframe
// (opaque origin) every storage access throws — this installs an in-memory shim.
// Import order is load order; moving this line breaks the web demo.
import "./lib/sandboxStorage";
import React from "react";
import ReactDOM from "react-dom/client";
// No webfonts — the poppy design kit's stacks are native (system sans + system
// mono), per the AgentsPoppy design contract (extension-sdk DESIGN.md).
import "./index.css";
import { App, WebDemoShell } from "./App";
import { isWebDemo } from "./lib/demoMode";

// ?demo=1 = the in-browser demo on agentspoppy.com (sandboxed iframe, no helper
// process, no AWS): render the demo inbox shell instead of the admin app. Decided
// here rather than inside App so App's hooks never sit behind a conditional.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isWebDemo() ? <WebDemoShell /> : <App />}</React.StrictMode>,
);

// The Tauri window launches hidden (`"visible": false`) so users never see the
// blank-webview flash on a cold start. Reveal it only once React has painted its
// first frame — a double requestAnimationFrame waits for layout + paint to
// commit. Outside Tauri (tests / plain browser) there's no window to show, so
// this is a no-op. If the hand-off ever fails, the Rust setup hook reveals the
// window after a short fallback delay, so the app can't get stuck invisible.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().show();
      } catch {
        /* Rust safety-net will reveal the window. */
      }
    }),
  );
}
