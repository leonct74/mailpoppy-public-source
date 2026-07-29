// Desktop client for the sidecar's "sending health" endpoint (admin-only — talks
// to the local sidecar with the admin's AWS credentials). Read-only.
import { sidecar } from "./sidecar";
import type { DeliverabilityOverview } from "@mailpoppy/core";

/**
 * Per-domain sending-health overview: an account-wide header (sending paused?,
 * daily quota, all-domains SES totals + do-not-send list) plus one row per domain
 * (sends, bounce/complaint counts + rates, do-not-send count).
 */
export function getDeliverabilityOverview(stackName: string): Promise<DeliverabilityOverview> {
  return sidecar(`/ses/deliverability/${encodeURIComponent(stackName)}`);
}

/**
 * Validate the recipient for the onboarding deliverability test. It must be an
 * EXTERNAL inbox — the whole point is to prove mail reaches the outside world —
 * so reject a malformed address and one on the domain being set up (which is
 * likely a mailbox that doesn't exist yet, so the test would just bounce/loop).
 * Returns a user-facing error message, or null when the recipient is fine.
 */
export function validateTestRecipient(recipient: string, domain: string): string | null {
  const to = recipient.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return "Enter a valid email address — e.g. you@gmail.com.";
  }
  if (to.split("@")[1] === domain.trim().toLowerCase()) {
    return (
      `Use a personal inbox on another provider (Gmail, Outlook, …), not an address on ${domain}. ` +
      `This test checks that your mail reaches the outside world — sending to your own new domain doesn't prove that, ` +
      `and that mailbox may not even exist yet.`
    );
  }
  return null;
}
