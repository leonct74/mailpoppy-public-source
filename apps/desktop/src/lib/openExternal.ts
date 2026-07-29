// Open an external URL (e.g. a presigned S3 attachment download) from the
// webview. In the Tauri shell, window.open() is a no-op, so we route through the
// opener plugin to hand the URL to the OS (default browser). Outside Tauri
// (plain browser / tests) we fall back to window.open. The plugin is imported
// lazily so this module loads fine in non-Tauri environments.
//
// Returns true if the URL was actually handed off (Tauri opener succeeded, or a
// browser window opened). Returns false when nothing could open it — e.g. a
// Tauri build whose opener plugin isn't active yet (needs a full app restart);
// callers should then surface the link so the user is never stuck.
import { inAgentsPoppyContainer, openExternalViaHost } from "./hostBridge";

export async function openExternal(url: string): Promise<boolean> {
  // Inside the AgentsPoppy container the iframe has neither a Tauri opener nor a
  // working window.open — only the host can reach the OS browser. Route through the
  // host's openExternal capability (declared in MailPoppy's manifest).
  if (inAgentsPoppyContainer()) {
    try {
      await openExternalViaHost(url);
      return true;
    } catch (hostErr) {
      console.warn("openExternal: host openExternal failed:", hostErr);
      return false;
    }
  }
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return true;
  } catch (tauriErr) {
    // The Tauri opener is unavailable or blocked (commonly a stale build whose
    // opener plugin/capability isn't active yet — needs a rebuild). Log it so a
    // failed hand-off is diagnosable from the webview devtools, then fall back to
    // window.open (a no-op inside the Tauri webview, real in a plain browser).
    console.warn("openExternal: Tauri opener failed, falling back to window.open:", tauriErr);
    try {
      const w =
        typeof window !== "undefined" && typeof window.open === "function"
          ? window.open(url, "_blank", "noopener,noreferrer")
          : null;
      if (!w) console.warn("openExternal: window.open could not open a window (expected inside the Tauri webview)");
      return !!w;
    } catch (winErr) {
      console.error("openExternal: both the Tauri opener and window.open threw:", winErr);
      return false;
    }
  }
}
