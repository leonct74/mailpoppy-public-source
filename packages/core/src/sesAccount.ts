// SES account / sandbox status model (DESIGN §13). SES starts every account in a
// "sandbox": you can only send to verified addresses, with a tiny daily quota.
// To run real mail an admin must request production access (a manual AWS review).
// These pure helpers normalize the SESv2 GetAccount shape into a UI state and
// validate the production-access request before the sidecar submits it.

/** SES production-access review state, mirrored from GetAccount Details.ReviewDetails.Status. */
export type SesReviewStatus = "PENDING" | "GRANTED" | "DENIED" | "FAILED";

/** What the admin actually needs to know about their sending posture. */
export type SendingAccessState =
  | "production" // out of the sandbox — can send to anyone
  | "pending" // production access requested, AWS reviewing
  | "denied" // AWS denied/failed the request — can re-submit
  | "disabled" // sending paused on the account (enforcement)
  | "sandbox" // still in the sandbox — verified recipients only
  | "unknown";

export interface SesSendQuota {
  /** Max messages in any 24h window (sandbox is typically 200). */
  max24Hour: number;
  /** Max messages per second. */
  maxSendRate: number;
  /** Messages sent in the last 24h. */
  sentLast24Hours: number;
}

export interface SesAccountStatus {
  productionAccessEnabled: boolean;
  sendingEnabled: boolean;
  enforcementStatus?: string; // e.g. "HEALTHY"
  reviewStatus?: SesReviewStatus;
  mailType?: string; // "TRANSACTIONAL" | "MARKETING"
  sendQuota?: SesSendQuota;
}

/**
 * Collapse the raw SES account fields into one state for the UI.
 * Order matters: production wins; then an in-flight/denied review; then a
 * paused account; otherwise it's the sandbox.
 */
export function sendingAccessState(s: SesAccountStatus | null | undefined): SendingAccessState {
  if (!s) return "unknown";
  if (s.productionAccessEnabled) return "production";
  if (s.reviewStatus === "PENDING") return "pending";
  if (s.reviewStatus === "DENIED" || s.reviewStatus === "FAILED") return "denied";
  if (!s.sendingEnabled) return "disabled";
  return "sandbox";
}

/** True while the account can only send to verified addresses. */
export function isSandboxed(s: SesAccountStatus | null | undefined): boolean {
  const state = sendingAccessState(s);
  return state === "sandbox" || state === "pending" || state === "denied";
}

// ---- Sandbox test-recipient verification ----
//
// While the account is in the sandbox, SES only delivers to VERIFIED addresses —
// so the wizard's "send yourself a test" step fails unless the admin's personal
// inbox is verified first. Verifying is just creating an SES email-address
// identity: AWS emails that address a click-link, and the identity flips to
// verified when it's clicked. These helpers model that flow for the UI.

/** Where a recipient address stands in SES's verification flow. */
export type RecipientVerificationState =
  | "verified" // SES will deliver to it, even in the sandbox
  | "pending" // AWS has emailed the verification link; waiting for the click
  | "failed" // the link expired unclicked (24h) — re-send to try again
  | "not-started"; // no SES identity for this address yet

export interface RecipientVerification {
  email: string;
  state: RecipientVerificationState;
}

/**
 * Collapse SESv2 GetEmailIdentity fields for an EMAIL_ADDRESS identity into one
 * UI state. `verifiedForSending` is authoritative when true; otherwise the
 * VerificationStatus enum decides. An existing-but-statusless identity means the
 * verification email went out, so it reads as pending, not not-started.
 */
export function recipientVerificationState(
  s: { verifiedForSending?: boolean; verificationStatus?: string } | null | undefined,
): RecipientVerificationState {
  if (!s) return "not-started";
  if (s.verifiedForSending) return "verified";
  const v = (s.verificationStatus ?? "").toUpperCase();
  if (v === "SUCCESS") return "verified";
  if (v === "FAILED") return "failed";
  return "pending"; // PENDING / TEMPORARY_FAILURE / NOT_STARTED / absent
}

/**
 * True when a send was rejected because the RECIPIENT isn't verified — the SES
 * sandbox signature ("Email address is not verified. The following identities
 * failed the check in region …: you@gmail.com"). The wizard uses this to route
 * into the verify-your-address flow instead of showing a raw AWS error.
 */
export function isUnverifiedRecipientError(message: string): boolean {
  const m = message.toLowerCase();
  // "identit" covers both the plural AWS emits today and a singular "identity failed
  // the check" — the wording is AWS's to change, and missing it dead-ends the user on
  // a raw error instead of the verify panel, so match the stem rather than the phrase.
  return m.includes("email address is not verified") || /identit(y|ies) failed the check/.test(m);
}

/**
 * Turn a failed PutAccountDetails into something the admin can act on.
 *
 * The request opens a real AWS Support case, and its failures are all things the
 * admin can understand and fix — but the SDK surfaces them as bare exception names
 * (and occasionally an empty message, which reaches the user as "unknown error").
 * Never return an empty string: an opaque failure on a button that opens a support
 * case reads as "the button is broken" (field report 2026-08-23).
 */
export function productionAccessErrorMessage(name?: string, message?: string): string {
  const n = (name ?? "").trim();
  const m = (message ?? "").trim();
  const hay = `${n} ${m}`.toLowerCase();

  if (/accessdenied|not authorized|unauthorizedoperation/.test(hay)) {
    return (
      "AWS refused the request because this connection isn't allowed to submit it " +
      "(ses:PutAccountDetails). If you're running MailPoppy through AgentsPoppy, open " +
      "AgentsPoppy and check MailPoppy's connection is active and its access was approved, " +
      "then try again."
    );
  }
  if (/conflict|already|inprogress|in progress/.test(hay)) {
    return (
      "AWS already has a production-access request open for this account, so it won't accept " +
      "another one. Check its progress in the AWS Support Center — this panel will show " +
      "\"granted\" once AWS approves it."
    );
  }
  if (/throttl|toomanyrequests|limitexceeded/.test(hay)) {
    return "AWS is rate-limiting this request. Wait a minute and try again.";
  }
  if (/badrequest|validation/.test(hay)) {
    return m
      ? `AWS rejected the details: ${m}`
      : "AWS rejected the details in this request. Check the website address and the description, then try again.";
  }
  // Unknown: show whatever AWS actually said, and never nothing at all.
  // Naming the exception type helps only when it IS a type — our own validation
  // errors are plain `Error`, and "(Error)" is noise on an already-clear sentence.
  if (m && n && n !== "Error") return `${m} (${n})`;
  return m || n || "AWS didn't say why the request failed. Please try again, and report this if it keeps happening.";
}

// ---- Production-access request ----

export type MailType = "TRANSACTIONAL" | "MARKETING";
export type ContactLanguage = "EN" | "JA";

export interface ProductionAccessRequest {
  /** Most Mailpoppy admins host their own correspondence → TRANSACTIONAL. */
  mailType: MailType;
  /** A real, reachable URL describing who's sending (AWS requires one). */
  websiteUrl: string;
  /** How you'll use SES — AWS reviewers read this; be specific. */
  useCaseDescription: string;
  contactLanguage: ContactLanguage;
  /** Optional extra addresses AWS may contact about the case. */
  additionalContactEmails?: string[];
}

const URL_RE = /^https?:\/\/[^\s.]+\.[^\s]+$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** AWS rejects terse descriptions; require enough to describe a real use case. */
export const MIN_USE_CASE_CHARS = 30;
export const MAX_USE_CASE_CHARS = 5000;

/**
 * Validate a production-access request locally so we fail fast with a clear
 * message instead of a generic SES ValidationException. Returns a list of
 * human-readable problems; empty means it's good to submit.
 */
export function validateProductionAccessRequest(r: Partial<ProductionAccessRequest> | null | undefined): string[] {
  const problems: string[] = [];
  if (!r) return ["Request is empty."];

  if (r.mailType !== "TRANSACTIONAL" && r.mailType !== "MARKETING") {
    problems.push("Pick a mail type (Transactional or Marketing).");
  }
  if (r.contactLanguage !== "EN" && r.contactLanguage !== "JA") {
    problems.push("Pick a contact language (EN or JA).");
  }
  if (!r.websiteUrl || !URL_RE.test(r.websiteUrl.trim())) {
    problems.push("Enter a valid website URL starting with http:// or https://.");
  }
  const desc = (r.useCaseDescription ?? "").trim();
  if (desc.length < MIN_USE_CASE_CHARS) {
    problems.push(`Describe your use case in at least ${MIN_USE_CASE_CHARS} characters.`);
  } else if (desc.length > MAX_USE_CASE_CHARS) {
    problems.push(`Use-case description must be ${MAX_USE_CASE_CHARS} characters or fewer.`);
  }
  for (const e of r.additionalContactEmails ?? []) {
    if (!EMAIL_RE.test(e.trim())) {
      problems.push(`"${e}" is not a valid email address.`);
    }
  }
  return problems;
}
