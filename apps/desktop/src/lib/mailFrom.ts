// Desktop client for the sidecar's custom MAIL FROM endpoints (admin-only —
// talks to the local sidecar with the admin's AWS credentials). Configuring a
// MAIL FROM subdomain aligns SPF to the sender's domain (DESIGN §13).
import { sidecar } from "./sidecar";
import type { MailFromState, DnsRecord } from "@mailpoppy/core";

/** Read the domain's current MAIL FROM config + verification status. */
export function getMailFromStatus(domain: string): Promise<MailFromState> {
  return sidecar(`/ses/mail-from/${encodeURIComponent(domain)}`);
}

export interface SetupMailFromResult {
  mailFromDomain: string;
  records: DnsRecord[];
  state: MailFromState;
}

/** Configure a custom MAIL FROM subdomain. Mutating (writes DNS) — confirm first. */
export function setupMailFrom(input: { domain: string; subdomain?: string }): Promise<SetupMailFromResult> {
  return sidecar("/ses/mail-from", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
