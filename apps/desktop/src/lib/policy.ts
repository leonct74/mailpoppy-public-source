// Desktop client for the sidecar's spam/auth policy endpoints (admin-only —
// talks to the local sidecar with the admin's AWS credentials). The policy
// (allow/block lists + per-verdict actions) is enforced by the inbound-processor
// Lambda, which reads it from the settings table (DESIGN §10).
import { sidecar } from "./sidecar";
import type { SpamPolicy } from "@mailpoppy/core";

/**
 * Read the current mail-filtering policy (defaults if never set). Pass `domain`
 * for a per-domain override; omit it for the deployment-wide default.
 */
export function getSpamPolicy(stackName: string, domain?: string): Promise<SpamPolicy> {
  const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
  return sidecar(`/policy/spam/${encodeURIComponent(stackName)}${q}`);
}

/** Save a mail-filtering policy. Pass `domain` to write a per-domain override. */
export function setSpamPolicy(input: { stackName?: string; policy: SpamPolicy; domain?: string }): Promise<{ ok: true; policy: SpamPolicy }> {
  return sidecar("/policy/spam", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
