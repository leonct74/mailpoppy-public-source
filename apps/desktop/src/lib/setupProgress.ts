// Pure, testable helpers for the setup wizard's progress model.
//
// The wizard is fragile if its progress lives only in React state: a remount, an
// HMR reload, or simply closing and reopening the app wipes it, and the user
// loses all sense of what they've done. These functions let the wizard
//   (a) reconstruct where the user is from what actually exists in their AWS
//       account ("resume from reality"), and
//   (b) render an always-visible, honest progress map with live status + time
//       expectations, so completed steps never vanish and in-flight work always
//       looks alive.

export type SetupStep =
  | "start"
  | "preflighted"
  | "deploying"
  | "deployed"
  | "provisioning"
  | "verifying"
  | "verified"
  | "sending"
  | "sent";

/** Steps at/after which the backend stack exists. */
const AFTER_DEPLOY: SetupStep[] = ["deployed", "provisioning", "verifying", "verified", "sending", "sent"];
/** Steps at/after which the domain's mail DNS has been published. */
const AFTER_PROVISION: SetupStep[] = ["verifying", "verified", "sending", "sent"];
/** Steps at/after which the domain is verified for sending/receiving. */
const AFTER_VERIFY: SetupStep[] = ["verified", "sending", "sent"];

export interface ResumeInput {
  /** listMailboxes succeeded → the backend stack is actually deployed (live truth). */
  backendDeployed: boolean;
  /** SES identities discovered for the stack — domains whose DNS is already set up. */
  domains: string[];
  /** Latest DKIM status for the candidate domain, if known. */
  dkim?: string;
  verifiedForSending?: boolean;
  /** A re-run pinned to one domain (opened from the domain view). */
  presetDomain?: string;
}

export interface ResumeState {
  domain: string;
  step: SetupStep;
  /** Domain DNS/SES exists but the backend stack does not — a partial leftover. */
  leftover: boolean;
}

/**
 * Reconstruct the wizard's position from real AWS state, so reopening the app
 * (or any remount) drops the user back exactly where they left off instead of an
 * empty form. Only ever moves forward from "start"; the caller must not let it
 * override a flow the user has already advanced in-session.
 */
export function deriveResume(i: ResumeInput): ResumeState {
  const domain = (i.presetDomain || i.domains[0] || "").toLowerCase();
  if (i.backendDeployed) {
    // Resume into a domain's verify state ONLY when MailPoppy actually provisioned
    // it — i.e. it published that domain's DKIM CNAMEs / MX / DMARC to Route53 (so
    // verification can eventually succeed). The evidence is membership in the
    // provisioned-domains list, which unions the backend's mailboxes, our receipt
    // rule's recipients, and the local provisioning ledger.
    //
    // A PRE-EXISTING domain the user created OUTSIDE MailPoppy (adopted via "Set up
    // with MailPoppy") also has an SES identity, so a status read succeeds and
    // `dkim !== undefined` — but its DKIM records were never written by us, so
    // polling for verification would spin forever. Such a domain must go through
    // the provision step first, so stay at "start": with the backend live, the
    // wizard's auto-preflight leads straight to "Set up email for this domain",
    // which publishes the records and THEN advances to verifying. Also stay at
    // "start" when there's no status signal at all (no domain, or status
    // unreachable) — never guess a step.
    const provisionedByUs = i.domains.some((d) => d.toLowerCase() === domain);
    if (domain && provisionedByUs && i.dkim !== undefined) {
      const verified = i.dkim === "SUCCESS" && i.verifiedForSending === true;
      // A FINISHED (verified) domain is only worth resuming when the user explicitly
      // reopened THAT domain (presetDomain). With no preset, opening setup means "add
      // ANOTHER domain" — start fresh with an empty form instead of stranding the user
      // on the finished domain's last step (which blocked adding a second domain).
      // An IN-PROGRESS (not-yet-verified) domain still resumes, so the verify poll picks
      // back up where it left off.
      if (verified && !i.presetDomain) return { domain: "", step: "start", leftover: false };
      return { domain, step: verified ? "verified" : "verifying", leftover: false };
    }
    return { domain, step: "start", leftover: false };
  }
  // No backend stack. A discovered domain means leftover DNS from a prior setup
  // that was partially torn down — surface it rather than silently re-deploying.
  return { domain, step: "start", leftover: domain !== "" };
}

export type PhaseKey = "connect" | "deploy" | "domain" | "verify" | "mailbox";
export type PhaseStatus = "done" | "current" | "upcoming";

export interface PhaseView {
  key: PhaseKey;
  label: string;
  status: PhaseStatus;
  /** True while AWS is actively working on this phase → render a live spinner. */
  busy: boolean;
  /** Sub-line: progress, a realistic time expectation, or the next action. */
  detail: string;
  /** This phase can stall in AWS for an undetermined time → warn + reassure. */
  canStall?: boolean;
}

export interface PhaseInput {
  ready: boolean;
  step: SetupStep;
  /** Live truth from listMailboxes (NOT the localStorage flag, which can be stale). */
  backendDeployed: boolean;
  mailboxCount: number;
}

/**
 * The always-visible progress map: one entry per phase, each with a live status
 * (done / current / upcoming), a spinner flag for in-flight work, a plain-language
 * detail line with time expectations, and a stall warning where AWS can take an
 * undetermined time (DKIM verification).
 */
export function setupPhases(i: PhaseInput): PhaseView[] {
  const { ready, step, backendDeployed, mailboxCount } = i;
  const deployed = backendDeployed || AFTER_DEPLOY.includes(step);
  const provisioned = AFTER_PROVISION.includes(step);
  const verified = AFTER_VERIFY.includes(step);

  const connect: PhaseView = {
    key: "connect",
    label: "Connect your AWS account",
    status: ready ? "done" : "current",
    busy: false,
    detail: ready ? "Connected — it's your own AWS account." : "Enter your AWS keys to begin.",
  };

  const deploy: PhaseView =
    step === "deploying"
      ? { key: "deploy", label: "Set up your email service", status: "current", busy: true, detail: "Setting it up now — usually 1–3 minutes." }
      : deployed
        ? { key: "deploy", label: "Set up your email service", status: "done", busy: false, detail: "Your email service is running." }
        : { key: "deploy", label: "Set up your email service", status: ready ? "current" : "upcoming", busy: false, detail: "A one-time setup, about 1–3 minutes." };

  const domain: PhaseView =
    step === "provisioning"
      ? { key: "domain", label: "Set up your domain's email", status: "current", busy: true, detail: "Adding your domain's DNS records — just a moment…" }
      : provisioned
        ? { key: "domain", label: "Set up your domain's email", status: "done", busy: false, detail: "DNS records added." }
        : { key: "domain", label: "Set up your domain's email", status: deployed ? "current" : "upcoming", busy: false, detail: "Adds the DNS records that let your domain send and receive email." };

  const verify: PhaseView =
    step === "verifying"
      ? { key: "verify", label: "Verify your domain", status: "current", busy: true, canStall: true, detail: "Checking automatically — usually minutes, occasionally up to an hour while DNS spreads worldwide." }
      : verified
        ? { key: "verify", label: "Verify your domain", status: "done", busy: false, detail: "Verified — ready to send and receive." }
        : { key: "verify", label: "Verify your domain", status: "upcoming", busy: false, canStall: true, detail: "DNS can take minutes — occasionally up to an hour — to take effect worldwide." };

  const mailbox: PhaseView =
    mailboxCount > 0
      ? { key: "mailbox", label: "Create your first mailbox", status: "done", busy: false, detail: `${mailboxCount} mailbox${mailboxCount === 1 ? "" : "es"} created.` }
      : verified
        ? { key: "mailbox", label: "Create your first mailbox", status: "current", busy: false, detail: "Ready — add an email address and password." }
        : { key: "mailbox", label: "Create your first mailbox", status: "upcoming", busy: false, detail: "Your email address, once the domain is verified." };

  return [connect, deploy, domain, verify, mailbox];
}
