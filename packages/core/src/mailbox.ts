// Pure mailbox logic shared by the access API and the inbound processor.
// Everything here is deterministic and side-effect-free so it can be unit-tested
// in isolation — this is where the security-critical key scoping lives, so the
// rules that decide "which mailbox owns a row" must never depend on client input.
// See DESIGN §6 (isolation), §8 (data model), §10 (policy).

import type {
  Folder,
  Verdict,
  AuthVerdicts,
  DeploymentPolicy,
} from "./types";

// ---- Address handling -------------------------------------------------------

/**
 * Normalize an email address for use as a key / comparison:
 *   - extract the bare address from a "Display Name <addr>" form
 *   - strip surrounding angle brackets and whitespace
 *   - lowercase (addresses are case-insensitive for our purposes)
 * Returns "" for input that has no usable address.
 */
export function normalizeAddress(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.trim();
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt !== -1 && gt !== -1 && gt > lt) {
    s = s.slice(lt + 1, gt);
  }
  return s.trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

/** The domain part (after the last "@") of an address, lowercased. "" if none. */
export function addressDomain(address: string): string {
  const a = normalizeAddress(address);
  const at = a.lastIndexOf("@");
  return at === -1 ? "" : a.slice(at + 1);
}

// ---- DynamoDB key derivation (the isolation boundary) -----------------------

const SEP = "#";

/**
 * Partition key for a mailbox: `${domain}#${address}`.
 * Derived solely from the (verified) owning address — callers must pass an
 * address proven to belong to the requester (e.g. a JWT `email` claim), NEVER a
 * value taken from request bodies/paths. This is the multi-tenant boundary.
 */
export function mailboxPk(ownerAddress: string): string {
  const addr = normalizeAddress(ownerAddress);
  return `${addressDomain(addr)}${SEP}${addr}`;
}

/** Sort key: `${folder}#${isoDate}#${messageId}` — sorts newest-last within a folder. */
export function messageSk(folder: Folder, isoDate: string, messageId: string): string {
  return `${folder}${SEP}${isoDate}${SEP}${messageId}`;
}

/** Prefix used to query a single folder within a mailbox partition. */
export function folderPrefix(folder: Folder): string {
  return `${folder}${SEP}`;
}

/**
 * S3 key for an extracted attachment: `attachments/<messageId>/<index>-<safeName>`.
 * The filename is sanitized to a safe key segment (path separators and odd
 * characters collapsed) so a hostile filename can't escape the prefix.
 */
export function attachmentS3Key(messageId: string, index: number, filename: string): string {
  const safe = (filename || "attachment").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  return `attachments/${messageId}/${index}-${safe}`;
}

export interface ParsedSk {
  folder: Folder;
  date: string;
  messageId: string;
}

/**
 * Inverse of {@link messageSk}. The messageId may itself contain "#" so we split
 * on the first two separators only and keep the remainder intact.
 */
export function parseSk(sk: string): ParsedSk {
  const first = sk.indexOf(SEP);
  const second = sk.indexOf(SEP, first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`malformed sort key: ${sk}`);
  }
  return {
    folder: sk.slice(0, first),
    date: sk.slice(first + 1, second),
    messageId: sk.slice(second + 1),
  };
}

// ---- Threading --------------------------------------------------------------

/** Strip surrounding angle brackets from a single Message-ID token. */
function bareId(id: string | null | undefined): string {
  return (id ?? "").trim().replace(/^<|>$/g, "").trim();
}

/**
 * Derive a stable thread id from MIME headers. RFC 5322 threading: the root of
 * the thread is the first id in `References`; failing that the `In-Reply-To`;
 * failing that the message is its own root.
 */
export function deriveThreadId(headers: {
  references?: string | string[] | null;
  inReplyTo?: string | null;
  messageId?: string | null;
}): string {
  const refs = Array.isArray(headers.references)
    ? headers.references
    : (headers.references ?? "").split(/\s+/).filter(Boolean);
  if (refs.length > 0) return bareId(refs[0]);
  const irt = bareId(headers.inReplyTo);
  if (irt) return irt;
  return bareId(headers.messageId) || "";
}

// ---- SES verdicts -----------------------------------------------------------

/** Map an SES receipt verdict status string onto our Verdict union. */
export function mapVerdict(status: string | null | undefined): Verdict {
  switch ((status ?? "").toUpperCase()) {
    case "PASS":
      return "PASS";
    case "FAIL":
      return "FAIL";
    case "PROCESSING_FAILED":
      return "PROCESSING_FAILED";
    case "GRAY":
    case "DISABLED":
    case "":
      return "GRAY";
    default:
      return "GRAY";
  }
}

// ---- Allow / block lists ----------------------------------------------------

/**
 * Does `address` match any entry in `list`? Entries may be:
 *   - a full address            ("alice@example.com")
 *   - a bare domain             ("example.com")
 *   - an "@domain" form         ("@example.com")
 * Matching is case-insensitive.
 */
export function addressMatchesList(address: string, list: readonly string[]): boolean {
  const addr = normalizeAddress(address);
  if (!addr) return false;
  const domain = addressDomain(addr);
  return list.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^@/, "");
    if (!e) return false;
    return e === addr || e === domain;
  });
}

/**
 * Is `address` one of the deployment's real mailboxes? Case-insensitive exact
 * match against the known mailbox addresses (Cognito users). Used by the
 * inbound-processor to reject mail to addresses that don't exist instead of
 * silently capturing it.
 */
export function isKnownMailbox(address: string, known: Iterable<string>): boolean {
  const addr = normalizeAddress(address);
  if (!addr) return false;
  for (const k of known) {
    if (normalizeAddress(k) === addr) return true;
  }
  return false;
}

// ---- Delivery decision (verdict + policy → folder) --------------------------

export interface DeliveryDecision {
  /** Target folder, or null to reject (do not store the message at all). */
  folder: Folder | null;
  /** Short machine-readable reason, useful for logs/tests. */
  reason:
    | "block-list"
    | "allow-list"
    | "virus"
    | "spam"
    | "auth-fail"
    | "clean";
}

/**
 * Decide where an inbound message lands, given SES verdicts and the deployment
 * policy. Order of precedence: block-list → allow-list → virus → spam → auth →
 * clean. A virus is never delivered to the inbox. Returns folder=null to drop.
 */
export function classifyDelivery(
  senderAddress: string,
  verdicts: AuthVerdicts,
  policy: DeploymentPolicy,
): DeliveryDecision {
  const { spam } = policy;

  if (addressMatchesList(senderAddress, spam.blockList)) {
    return { folder: null, reason: "block-list" };
  }
  if (addressMatchesList(senderAddress, spam.allowList)) {
    return { folder: "inbox", reason: "allow-list" };
  }

  if (verdicts.virus === "FAIL") {
    return { folder: spam.onVirus === "reject" ? null : "junk", reason: "virus" };
  }

  if (verdicts.spam === "FAIL") {
    if (spam.onSpam === "reject") return { folder: null, reason: "spam" };
    return { folder: spam.onSpam === "junk" ? "junk" : "inbox", reason: "spam" };
  }

  const authFailed =
    verdicts.spf === "FAIL" || verdicts.dkim === "FAIL" || verdicts.dmarc === "FAIL";
  if (authFailed) {
    switch (spam.onAuthFail) {
      case "reject":
        return { folder: null, reason: "auth-fail" };
      case "junk":
        return { folder: "junk", reason: "auth-fail" };
      default: // "tag" | "allow"
        return { folder: "inbox", reason: "auth-fail" };
    }
  }

  return { folder: "inbox", reason: "clean" };
}
