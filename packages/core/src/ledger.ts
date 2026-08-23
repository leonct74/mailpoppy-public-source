// Pure reductions over the append-only provisioning ledger.
//
// The ledger records every AWS resource MailPoppy creates or deletes, in order.
// Teardown REPLAYS it to decide what to clean up, and the dashboard replays it to
// decide which domains MailPoppy hosts — so a misreading here has real blast radius
// in the admin's own AWS account. That makes it exactly the kind of logic this repo
// keeps as pure, unit-tested functions in @mailpoppy/core (cf. mailbox.ts).

/** The subset of a ledger entry these reductions need (see node-sidecar/src/ledger.ts). */
export interface LedgerIdentityEntry {
  action: string; // "created" | "deleted" | "updated"
  service: string; // "SES" | "Route53" | ...
  resourceType: string; // "EmailIdentity" | ...
  name: string;
}

/**
 * The SES **domain** identities that still exist, per the ledger.
 *
 * Two kinds of row share `resourceType: "EmailIdentity"`:
 *   - a DOMAIN identity  ("ollydigital.com")   — a domain the admin hosts here, and
 *   - an EMAIL-ADDRESS identity ("you@gmail.com") — a verified TEST RECIPIENT, created
 *     so a sandboxed account can send its deliverability test to a personal inbox.
 *
 * Only the first kind is a provisioned domain. Conflating them published a phantom
 * "gmail.com" domain on the dashboard — and, far worse, fed it to teardown's DNS
 * cleanup list, which would strip SES DNS records from a domain the admin never
 * asked MailPoppy to touch (field bug 2026-08-23, shipped in 0.1.19).
 *
 * The ledger is append-only and chronological, so replaying created/deleted in order
 * leaves only what is still live — a domain that was set up and later torn down
 * correctly disappears instead of lingering as a ghost.
 */
export function liveDomainIdentities(entries: readonly LedgerIdentityEntry[]): string[] {
  const live = new Set<string>();
  for (const e of entries) {
    if (e.service !== "SES" || e.resourceType !== "EmailIdentity") continue;
    const name = (e.name ?? "").trim().toLowerCase();
    if (!name) continue;
    if (name.includes("@")) continue; // a verified recipient, not a hosted domain
    if (e.action === "created") live.add(name);
    else if (e.action === "deleted") live.delete(name);
  }
  return [...live].sort();
}

/**
 * The verified TEST-RECIPIENT addresses that still exist, per the ledger — the exact
 * complement of {@link liveDomainIdentities}. Teardown deletes these so a personal
 * address MailPoppy asked AWS to verify doesn't linger in the account afterwards.
 */
export function liveRecipientIdentities(entries: readonly LedgerIdentityEntry[]): string[] {
  const live = new Set<string>();
  for (const e of entries) {
    if (e.service !== "SES" || e.resourceType !== "EmailIdentity") continue;
    const name = (e.name ?? "").trim().toLowerCase();
    if (!name || !name.includes("@")) continue;
    if (e.action === "created") live.add(name);
    else if (e.action === "deleted") live.delete(name);
  }
  return [...live].sort();
}
