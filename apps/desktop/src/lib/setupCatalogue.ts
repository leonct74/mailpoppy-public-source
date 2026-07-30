// The words the domain + mailbox setup surfaces use, in one place.
//
// AGENTS.md §9 requires the helper prompt to be GENERATED from the same catalogue the form
// renders — a hand-maintained second copy of this text would drift, and a helper that
// describes an option the form doesn't have is worse than no helper. So SetupWizard,
// DomainView and AgentOwnedToggle render these constants, and lib/helper-prompt.ts describes
// them. Text that changes here changes in both places, on the same commit.

/** The domain step (SetupWizard "Steps 1–4"). */
export const DOMAIN_STEP = {
  label: "Domain",
  placeholder: "yourdomain.com",
  what:
    "The domain your email addresses will end in. You need to own it already — MailPoppy doesn't " +
    "register domains.",
  /** The hard prerequisite that strands people if they don't know it up front. */
  requirement:
    "The domain's DNS must be hosted in the SAME AWS account you're connecting, in Route 53. If it " +
    "lives at another registrar or DNS host, move the DNS to Route 53 in this account FIRST — the " +
    "email step cannot run without it.",
  dnsStep:
    "MailPoppy writes the DNS records itself (MX for receiving, DKIM for signing, SPF and DMARC for " +
    "being trusted). You don't paste anything by hand. Verification then takes a few minutes, " +
    "occasionally up to an hour while the change spreads across the internet, and it keeps checking " +
    "in the background — you can close the app and come back.",
};

/** The two deploy choices on the "set up email service" step. Both default ON. */
export const DEPLOY_OPTIONS = [
  {
    key: "malwareScan",
    label: "Scan attachments for viruses",
    recommended: true,
    what: "Checks files for malware before anyone can download them.",
    caution: "There's a small AWS cost, but it's usually free for a personal mailbox.",
  },
  {
    key: "encryptAtRest",
    label: "Lock each mailbox with its owner's password",
    recommended: true,
    what: "So even you, the account owner, can't read someone's email.",
    caution:
      "Only turn this off if some people will read their mail in an older MailPoppy app that can't " +
      "open locked mail. The subject and sender stay visible either way.",
  },
] as const;

/** The mailbox creation form (SetupWizard's first mailbox, and DomainView's "New mailbox"). */
export const MAILBOX_FIELDS = {
  address: {
    label: "Email address",
    placeholder: "you",
    what:
      "The part before the @ — MailPoppy adds your domain. A mailbox is a real sign-in account: " +
      "someone can log in to it and read mail in the Inbox tab.",
  },
  password: {
    label: "Password",
    what: "The sign-in password for that mailbox.",
    policy:
      "Password must meet the pool policy (min 8 chars, with upper & lower case, a number and a symbol).",
  },
  /** The gate that blocks mailbox creation until DNS verifies. */
  gate:
    "Mailboxes can only be added once the domain is verified for sending. A mailbox on a domain that " +
    "isn't ready yet can't send or receive, so the form stays locked until verification finishes.",
  /** The bounce trap: an address people already write to needs a mailbox promptly. */
  existingMailWarning:
    "If people ALREADY send email to an address on this domain (say hello@), add a mailbox for it " +
    "soon. Until it has one, new messages to that address are rejected and the sender gets a " +
    "delivery-failure notice.",
};

/**
 * Aliases: honestly, they don't exist yet.
 *
 * Rule 1 forbids the prompt from describing options the form doesn't have, and MailPoppy has no
 * alias UI — aliases are an unbuilt Phase 5 line item (DESIGN.md §18), and catch-all was
 * deliberately REJECTED as an anti-pattern (spam magnet + backscatter + silent-misroute risk,
 * DESIGN.md §19). So the prompt states the current reality and the workaround, rather than
 * inventing a field. When aliases ship, this constant is the one place to update.
 */
export const ALIASES = {
  available: false,
  what:
    "MailPoppy has no alias or catch-all feature today. Every address you want to receive mail at " +
    "needs its own mailbox, each with its own password. Catch-all is deliberately NOT offered — it " +
    "attracts spam and silently misroutes mail. So if someone wants sales@, support@ and info@ to " +
    "reach them, that is three mailboxes for now; list them and say plainly that it's three " +
    "sign-ins, not one inbox with three names.",
};

/**
 * The agent-owned mailbox toggle — the CrewPoppy bridge (DESIGN.md §14.2).
 *
 * The sibling-promotion rule (AGENTS.md §9) says name the sibling poppy and the exact step,
 * honestly scoped. The founder's own note on this control (2026-07-29) is to say the
 * PREREQUISITE FIRST: without CrewPoppy the switch does nothing, and a switch wired to nothing
 * is the worst outcome. That ordering is preserved here and in the prompt.
 */
export const AGENT_MAILBOX = {
  trigger: "Assign this mailbox to an AI agent…",
  prerequisiteFirst:
    "This needs CrewPoppy — the AgentsPoppy app that runs AI agents in your own AWS account. If " +
    "CrewPoppy isn't installed and set up, this switch does nothing: mail just delivers normally.",
  what:
    "With CrewPoppy, mail arriving for the mailbox starts the agent that owns this address — so you " +
    "can email it an instruction from anywhere.",
  /** Non-negotiable: the exact sentence the toggle must show before enabling (pinned by test). */
  privacyWarning:
    "An agent mailbox is NOT private the way human mailboxes are — its incoming mail is handed to an AI agent in plain text.",
  scope:
    "Your human mailboxes are unchanged, and only mail that passes authentication and comes from " +
    "your own address can start a run.",
  /** The exact step, for the prompt — this is what makes the sibling promotion actionable. */
  crossPoppyStep:
    "Create the mailbox here first, then open its row and use \"Assign this mailbox to an AI agent\". " +
    "It then appears in CrewPoppy's own mailbox dropdown when you give an agent an email capability. " +
    "Only do this for a mailbox meant for an agent — never for a person's mailbox.",
};
