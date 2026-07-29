// Desktop client for the sidecar's retention settings (admin-only). How long mail
// is kept is enforced by the janitor Lambda, which reads these from the settings
// table (DESIGN §10).
import { sidecar } from "./sidecar";
import type { RetentionSettings } from "@mailpoppy/core";

/** Read retention settings. Pass `domain` for a per-domain override; omit for the default. */
export function getRetention(stackName: string, domain?: string): Promise<RetentionSettings> {
  const q = domain ? `?domain=${encodeURIComponent(domain)}` : "";
  return sidecar(`/policy/retention/${encodeURIComponent(stackName)}${q}`);
}

/** Save retention settings. Pass `domain` to write a per-domain override. */
export function setRetention(input: { stackName?: string; retention: RetentionSettings; domain?: string }): Promise<{ ok: true; retention: RetentionSettings }> {
  return sidecar("/policy/retention", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
