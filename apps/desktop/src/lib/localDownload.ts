// Save bytes that exist only in the webview (e.g. a *decrypted* attachment) to a
// file the user can keep. WKWebView won't honour a blob/`<a download>` click, so
// we hand the bytes to the local sidecar for a one-shot token and open the
// matching loopback URL through the system browser — which downloads it cleanly
// (the sidecar sets Content-Disposition: attachment). This mirrors how plaintext
// attachments are handed off (openExternal on the presigned S3 URL).
import { sidecar, SIDECAR } from "./sidecar";
import { inAgentsPoppyContainer } from "./hostBridge";
import { openExternal } from "./openExternal";

/**
 * The URL the system browser should fetch for a one-shot download token.
 * Standalone, that's the sidecar's fixed loopback port. In the AgentsPoppy
 * container the backend listens on a broker-assigned port the frontend can't
 * know — but the broker exposes a narrow passthrough (`/ext-dl/<id>/local-download/
 * <token>`) on the SAME origin that serves this frontend (`/ext-ui/<id>/…`), so the
 * URL is derived from our own location. The backend's port stays hidden throughout.
 */
function downloadUrlFor(token: string): string {
  const tok = encodeURIComponent(token);
  if (inAgentsPoppyContainer()) {
    // location.origin can read "null" in a sandboxed frame — parse the full href.
    const here = new URL(window.location.href);
    const m = here.pathname.match(/^\/ext-ui\/([^/]+)\//);
    if (m) return `${here.protocol}//${here.host}/ext-dl/${m[1]}/local-download/${tok}`;
  }
  return `${SIDECAR}/local-download/${tok}`;
}

// Base64-encode bytes without blowing the call stack on large attachments
// (String.fromCharCode(...bytes) overflows for multi-MB files). FileReader's
// data URL does the encoding natively, then we strip the "data:...;base64," head.
function bytesToBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result as string;
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes as BlobPart]));
  });
}

/**
 * Download in-memory bytes to a file via the sidecar handoff + system browser.
 * Returns the loopback URL that was opened, so the caller can offer a manual
 * "open in browser" fallback if the OS opener wasn't available.
 */
export async function downloadBytesViaSidecar(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<{ url: string; opened: boolean }> {
  const dataB64 = await bytesToBase64(bytes);
  const { token } = await sidecar<{ token: string }>("/local-download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, contentType, dataB64 }),
  });
  const url = downloadUrlFor(token);
  const opened = await openExternal(url);
  return { url, opened };
}

/** How a save ended: written straight to Downloads (`savedAs`), handed to the
 *  browser (`opened`), or neither — the caller should surface the manual link. */
export interface SaveOutcome {
  /** Final filename inside ~/Downloads when the silent save succeeded. */
  savedAs?: string;
  /** Set when the browser-handoff fallback ran instead. */
  url?: string;
  opened?: boolean;
}

/**
 * Save bytes to the user's Downloads folder WITHOUT opening a browser window —
 * the professional path. Falls back to the classic browser handoff when the
 * sidecar predates the save route (older packaged binary), so a download always
 * completes somewhere.
 */
export async function saveBytesToDownloads(
  filename: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<SaveOutcome> {
  const dataB64 = await bytesToBase64(bytes);
  try {
    const res = await sidecar<{ ok: true; path: string; filename?: string }>("/local-download/save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, dataB64 }),
    });
    return { savedAs: res.filename ?? filename };
  } catch (e) {
    if (!/sidecar 404/.test(String(e))) throw e; // a real failure — not just an old binary
    const { url, opened } = await downloadBytesViaSidecar(filename, contentType, bytes);
    return { url, opened };
  }
}
