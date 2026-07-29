// AgentsPoppy host bridge — GUEST side.
//
// When MailPoppy runs as an extension INSIDE the AgentsPoppy container it lives in a
// sandboxed iframe with no network access to its own sidecar (opaque origin). Backend
// calls are instead proxied to the host over postMessage; the host services them
// against the sidecar process it spawned for this connection and gates them on
// MailPoppy's manifest-declared capabilities.
//
// This is a tiny, self-contained mirror of @agentspoppy/extension-sdk's bridge (no
// cross-repo build dependency — same approach as agentspoppyBroker.ts in the sidecar).
// Standalone (the normal Tauri window), none of this is used: sidecar() fetches the
// loopback sidecar directly.

interface HostRequest {
  id: string;
  method: string;
  params: unknown[];
}
type HostResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/**
 * An UNSOLICITED message the host pushes to this frame (not a reply to a request). The
 * host sends one when something about our connection changed out from under us — e.g.
 * the operator tore the backend down from the AgentsPoppy console — so we can refresh
 * instead of showing a footprint that no longer exists. Distinguished from a
 * HostResponse by the `hostEvent` discriminator (a response has `id`+`ok`; an event has
 * neither). Mirrors `HostEvent` in @agentspoppy/extension-sdk.
 */
export type HostEvent = { hostEvent: "connection-changed"; connectionId?: string; reason?: string };

/**
 * True when MailPoppy is running inside the AgentsPoppy container (an iframe) rather
 * than as the standalone top-level Tauri window. A cross-origin access throw also
 * means we're framed, so treat it as container mode.
 */
export function inAgentsPoppyContainer(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

// A generous cap so a long-running backend call (e.g. a deploy that polls AWS) isn't
// killed mid-flight; it only fires if the host genuinely never answers.
const BRIDGE_TIMEOUT_MS = 15 * 60 * 1000;

let seq = 0;
let wired = false;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const eventListeners = new Set<(e: HostEvent) => void>();

function ensureWired(): void {
  if (wired) return;
  wired = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as (Partial<HostResponse> & Partial<HostEvent>) | null;
    if (!data) return;
    // Host push event (unsolicited) — fan out to subscribers, never a pending request.
    if (typeof data.hostEvent === "string") {
      const evt = data as HostEvent;
      for (const cb of [...eventListeners]) cb(evt);
      return;
    }
    // Otherwise it's a reply to one of our requests.
    if (typeof data.id !== "string" || typeof (data as HostResponse).ok !== "boolean") return;
    const p = pending.get(data.id);
    if (!p) return; // unknown / duplicate correlation id
    pending.delete(data.id);
    clearTimeout(p.timer);
    if ((data as { ok: boolean }).ok) p.resolve((data as { result: unknown }).result);
    else p.reject(new Error((data as { error: string }).error));
  });
}

/**
 * Subscribe to unsolicited {@link HostEvent}s the AgentsPoppy host pushes (e.g. our
 * backend was torn down from the console). Returns an unsubscribe fn. Standalone (no
 * host), this simply never fires — safe to call unconditionally.
 */
export function onHostEvent(handler: (e: HostEvent) => void): () => void {
  ensureWired();
  eventListeners.add(handler);
  return () => eventListeners.delete(handler);
}

function callHost<T>(method: string, params: unknown[]): Promise<T> {
  ensureWired();
  return new Promise<T>((resolve, reject) => {
    const id = `mp-${Date.now().toString(36)}-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("AGENTSPOPPY_BRIDGE_TIMEOUT"));
    }, BRIDGE_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    (window.parent ?? window).postMessage({ id, method, params } as HostRequest, "*");
  });
}

/** Proxy a backend call to MailPoppy's sidecar via the host. Resolves the parsed JSON body. */
export function invokeBackend<T>(req: { method: string; path: string; body?: unknown }): Promise<T> {
  return callHost<T>("invokeBackend", [req]);
}

/**
 * Ask the host to open a URL in the OS browser (gated by the `host:openExternal`
 * capability). Inside the container the iframe can't open OS windows itself
 * (window.open is a no-op in the host webview, no Tauri opener in the frame), so this
 * is how a presigned attachment URL / external link actually reaches the browser.
 */
export function openExternalViaHost(url: string): Promise<void> {
  return callHost<void>("openExternal", [url]);
}
