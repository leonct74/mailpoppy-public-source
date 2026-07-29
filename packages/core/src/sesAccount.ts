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
