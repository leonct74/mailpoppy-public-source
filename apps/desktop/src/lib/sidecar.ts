// Thin client for the local provisioning sidecar (desktop-admin-only).
import * as host from "./hostBridge";

export const SIDECAR = "http://127.0.0.1:8787";

// Low-level connectivity failures that bubble up from the AWS SDK inside the
// sidecar when this machine is offline or its DNS is unavailable. We translate
// them into one clear, actionable message instead of leaking a raw 5xx / a
// cryptic "getaddrinfo ENOTFOUND route53.amazonaws.com".
const NETWORK_ERROR_CODES = [
  "ENOTFOUND", // DNS lookup failed (offline / DNS down)
  "EAI_AGAIN", // DNS temporary failure
  "ETIMEDOUT", // connection timed out
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
];
// A connectivity failure means different things by endpoint: the migration
// routes talk to the *source* mail server the user is importing from (often not
// AWS at all), while everything else talks to AWS. Point the user at the right
// place instead of blaming "AWS" for an unreachable IMAP host.
function networkMessage(path: string): string {
  return path.startsWith("/migrate")
    ? "Couldn't reach the mail server you're importing from. Check the host and port are correct and your internet connection is up, then try again."
    : "Couldn't reach AWS — please check your internet connection and try again.";
}

const HELPER_UNREACHABLE =
  "Couldn't reach MailPoppy's local helper. Please restart the app and try again.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Only safe, idempotent reads get auto-retried on a transport failure. A POST
// that drops mid-flight could have been received and processed by the sidecar,
// so replaying it (e.g. a deploy or a domain removal) is unsafe — those fail
// fast with the existing message instead.
function isIdempotent(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" || method === "HEAD";
}

/**
 * In the AgentsPoppy container MailPoppy's iframe can't reach the sidecar directly, so
 * backend calls are proxied to the host over postMessage. We rebuild the exact same
 * contract the standalone path exposes: parsed JSON on success, and on a backend error
 * the host's `backend <status>: <body>` is re-wrapped to `sidecar <status>: <body>` so
 * friendlyError + the wizard's 404 detection behave identically. A bridge/transport
 * failure maps to the same "local helper unreachable" message as a dropped fetch.
 */
async function sidecarViaHost<T>(path: string, init?: RequestInit): Promise<T> {
  let body: unknown;
  if (init?.body !== undefined) {
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      body = init.body; // non-JSON body — pass through as-is
    }
  }
  try {
    return await host.invokeBackend<T>({ method: (init?.method ?? "GET").toUpperCase(), path, body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/^backend (\d{3}): ([\s\S]*)$/);
    if (m) throw new Error(`sidecar ${m[1]}: ${m[2]}`); // preserve the status-coded contract
    throw new Error(HELPER_UNREACHABLE); // bridge timeout / no backend / transport failure
  }
}

export async function sidecar<T>(path: string, init?: RequestInit): Promise<T> {
  if (host.inAgentsPoppyContainer()) return sidecarViaHost<T>(path, init);
  // The sidecar is a Node binary Rust spawns at launch; on a cold start it may
  // not be listening yet when the first reads fire, so fetch() rejects at the
  // transport level (ECONNREFUSED) until it binds. Retry idempotent reads with a
  // short backoff (~4s total) so the boot race resolves silently instead of
  // surfacing "restart the app" for what is really just a slow start.
  const maxAttempts = isIdempotent(init) ? 11 : 1;
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${SIDECAR}${path}`, init);
      break;
    } catch {
      // Transport-level failure: the local helper isn't reachable (still
      // starting, or crashed) — not an internet problem.
      if (attempt >= maxAttempts) throw new Error(HELPER_UNREACHABLE);
      await sleep(Math.min(500, 100 * attempt));
    }
  }
  if (!res.ok) {
    const body = await res.text();
    // A connectivity failure → tell the user what was unreachable (AWS, or the
    // source mail server for migrations), rather than surfacing the raw 500.
    if (NETWORK_ERROR_CODES.some((code) => body.includes(code))) {
      throw new Error(networkMessage(path));
    }
    // Everything else keeps the original format so callers that key off the
    // status code (e.g. the wizard's "no backend yet" 404 detection) still work.
    throw new Error(`sidecar ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}
