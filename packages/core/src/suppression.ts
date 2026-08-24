// The do-not-send (suppression) list.
//
// SES notifies us of every hard bounce and spam complaint; the suppression Lambda records
// the address so we stop mailing it. Repeatedly sending to addresses that bounce, or to
// people who marked you as spam, is the fastest way to have AWS throttle or suspend an
// account — so this list is a deliverability control, not a nicety.
//
// 🪤 Until 2026-08-23 the list was WRITE-ONLY: suppression.ts wrote the rows and the
// Sending Health view displayed them, but the send path never consulted it (the Lambda's
// own comment claiming otherwise was stale). The user-visible half of that bug is worse
// than the compliance half: AWS's account-level suppression list silently accepts the
// send and never delivers it, so the sender believes a message went out that didn't.
// These helpers exist so the writer, the reader and the send path can never drift again.

import { normalizeAddress } from "./mailbox";

/** Settings-table primary key for one suppressed address. */
export function suppressionKey(address: string): string {
  return `SUPPRESS#${normalizeAddress(address)}`;
}

/** The address a suppression key refers to ("" if it isn't one). */
export function addressFromSuppressionKey(pk: string): string {
  return pk.startsWith("SUPPRESS#") ? pk.slice("SUPPRESS#".length) : "";
}

/** Why an address is on the list. */
export interface SuppressionRecord {
  address: string;
  /** "bounce" (mail kept failing) or "complaint" (marked as spam). */
  reason?: string;
  detail?: string;
  suppressedAt?: string;
}

/** Recipients split into those we may mail and those we must not. */
export interface RecipientSplit {
  allowed: string[];
  blocked: SuppressionRecord[];
}

/**
 * Split a send's recipients against the suppression list. Case/whitespace-insensitive,
 * and de-duplicated, so the same address in To and Cc is reported once.
 */
export function splitSuppressedRecipients(
  recipients: readonly string[],
  suppressed: readonly SuppressionRecord[],
): RecipientSplit {
  const byAddress = new Map<string, SuppressionRecord>();
  for (const s of suppressed) {
    const a = normalizeAddress(s.address ?? "");
    if (a) byAddress.set(a, { ...s, address: a });
  }
  const allowed: string[] = [];
  const blocked: SuppressionRecord[] = [];
  const seen = new Set<string>();
  for (const raw of recipients) {
    const a = normalizeAddress(raw ?? "");
    if (!a || seen.has(a)) continue;
    seen.add(a);
    const hit = byAddress.get(a);
    if (hit) blocked.push(hit);
    else allowed.push(a);
  }
  return { allowed, blocked };
}

/** Plain-language reason, for a message the sender actually reads. */
function reasonPhrase(r?: string): string {
  if (r === "complaint") return "marked a previous message as spam";
  if (r === "bounce") return "mail to it kept bouncing";
  return "previous mail to it failed";
}

/**
 * The refusal shown to the sender. Names every blocked address and why, because the
 * alternative — the silent non-delivery AWS would otherwise perform — is what makes this
 * worth blocking at all. Also says how to undo it, so a fixed address isn't stuck forever.
 */
export function suppressedRecipientsMessage(blocked: readonly SuppressionRecord[]): string {
  const list = blocked.map((b) => `${b.address} (${reasonPhrase(b.reason)})`).join(", ");
  const noun = blocked.length === 1 ? "this address" : "these addresses";
  return (
    `Your message wasn't sent. Mail to ${noun} is on hold: ${list}. ` +
    `Sending to addresses that bounce, or to people who reported your mail as spam, is what gets an ` +
    `AWS account throttled or suspended — so MailPoppy stops it rather than letting Amazon drop the ` +
    `message silently. If the address has been fixed, an administrator can clear it under Sending health.`
  );
}
