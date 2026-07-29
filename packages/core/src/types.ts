// Shared domain model for Mailpoppy. See DESIGN.md §7–§10.
// These types are the contract between the clients, the access API, and the Lambdas.

/** A DNS-verified domain hosted inside a deployment. */
export interface Domain {
  name: string; // e.g. "ollydigital.com"
  region: string; // SES inbound region, e.g. "eu-west-1"
  status: DomainStatus;
  dkimVerified: boolean;
  productionAccess: boolean; // SES out of the sandbox?
  createdAt: string; // ISO 8601
}

export type DomainStatus = "pending" | "verifying" | "active" | "error";

/** A mailbox identity (Cognito user). Owns one primary address + optional aliases. */
export interface MailboxUser {
  sub: string; // Cognito subject (stable id)
  primaryAddress: string; // e.g. "you@ollydigital.com"
  aliases: string[]; // additional addresses this user owns
  displayName?: string;
  domain: string;
  disabled?: boolean;
}

export type Folder = "inbox" | "sent" | "drafts" | "trash" | "junk" | (string & {});

export interface MessageFlags {
  unread: boolean;
  starred?: boolean;
  answered?: boolean;
}

export type Verdict = "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED";

export interface AuthVerdicts {
  spam: Verdict;
  virus: Verdict;
  spf?: Verdict;
  dkim?: Verdict;
  dmarc?: Verdict;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  sizeBytes: number;
  s3Key?: string; // set once extracted to its own object (optimization; DESIGN §10)
}

/**
 * One row in the DynamoDB `index` table — the unit of "mailbox state" the app
 * manufactures on top of the raw S3 .eml objects (DESIGN §8.2).
 *   PK = `${domain}#${mailbox}`
 *   SK = `${folder}#${date}#${messageId}`
 */
export interface MessageMeta {
  domain: string;
  mailbox: string; // primary address of the owning mailbox
  messageId: string;
  threadId: string;
  folder: Folder;
  from: EmailAddress;
  to: EmailAddress[];
  subject: string;
  snippet: string;
  date: string; // ISO 8601
  flags: MessageFlags;
  hasAttachments: boolean;
  attachments?: AttachmentMeta[];
  verdicts?: AuthVerdicts;
  s3Key: string; // raw .eml location in S3 (CIPHERTEXT when `encrypted`)
  sizeBytes: number;
  /**
   * Mailbox encryption (docs/mailbox-encryption-design.md). When true, the body
   * (the .eml at `s3Key`) and every attachment object are sealed with a per-
   * message content key; `encWrappedKey` is that content key sealed to THIS
   * recipient's public key (base64). The client recovers the content key with its
   * private key and decrypts. `subject` and routing metadata stay cleartext (the
   * inbound Lambda needs them); `snippet` is blank for encrypted messages because
   * it is body text. Absent/false ⇒ stored in clear (e.g. received before the
   * mailbox was activated — see §10 mail-before-activation).
   */
  encrypted?: boolean;
  encWrappedKey?: string; // base64 — content key sealed to this recipient's pubkey
}

// ---- Admin-configurable policy (DESIGN §10): per-deployment default + per-domain override ----

export interface RetentionPolicy {
  mode: "purge-after" | "never" | "hard-delete";
  trashPurgeDays: number; // default 30
}

export interface SpamPolicy {
  onVirus: "reject" | "quarantine"; // never inbox a virus
  onSpam: "junk" | "tag" | "reject";
  onAuthFail: "junk" | "tag" | "reject" | "allow";
  allowList: string[];
  blockList: string[];
}

export interface DeploymentPolicy {
  retention: RetentionPolicy;
  spam: SpamPolicy;
  attachmentMaxBytes?: number; // optional soft cap below the ~40MB AWS ceiling
  deepSearchEnabled: boolean; // Athena opt-in (billed in the admin's AWS)
}

export const DEFAULT_POLICY: DeploymentPolicy = {
  retention: { mode: "purge-after", trashPurgeDays: 30 },
  spam: { onVirus: "quarantine", onSpam: "junk", onAuthFail: "junk", allowList: [], blockList: [] },
  deepSearchEnabled: false,
};

// ---- Hard AWS limits (DESIGN §10) ----
export const SES_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
/**
 * Largest total raw attachment bytes a client should let a user add to one
 * message. This is NOT bounded by SES's 40 MB ceiling — the binding limit is the
 * send transport: attachments travel as base64 inside the JSON request body
 * (base64 inflates raw bytes by ~1.33×), and that request must pass through
 *   • API Gateway HTTP API — hard 10 MB request payload limit, returns 413, and
 *   • the access-api Lambda — synchronous invocation payload limit of 6 MB.
 * The Lambda's 6 MB is the tighter wall: 4 MB raw → ~5.6 MB base64 + headers,
 * comfortably under 6 MB. Anything larger needs a different upload path
 * (presigned S3 PUT + server-side MIME assembly), not a config change.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const SES_INBOUND_REGIONS = ["eu-west-1", "us-east-1", "us-west-2"] as const;
export type SesInboundRegion = (typeof SES_INBOUND_REGIONS)[number];
