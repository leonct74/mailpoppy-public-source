// The AI helper prompt (AGENTS.md §9, REQUIRED — founder 2026-07-30): onboarding is a prompt,
// not a manual. Setting up mail on your own domain is the most intimidating thing MailPoppy
// asks of anyone — DNS, MX records, who gets which address. So instead of a manual, hand the
// user a prompt that IS the training: paste it into whatever AI they already talk to, say who
// needs email, get back the domain to type, the mailboxes to create and the boxes to tick.
//
// Built LIVE from ./setupCatalogue.ts — the same constants SetupWizard, DomainView and
// AgentOwnedToggle render — so the prompt can never describe a field the forms don't have.
// That cuts the other way too: MailPoppy has NO alias or catch-all feature, so the prompt says
// so and gives the workaround, rather than inventing a field an outside AI would love to fill.
//
// Follows lib/policies.ts as the precedent for copyable content living in lib/, not in a view.

import { AGENT_MAILBOX, ALIASES, DEPLOY_OPTIONS, DOMAIN_STEP, MAILBOX_FIELDS } from "./setupCatalogue";

export function buildHelperPrompt(opts?: { domain?: string; region?: string }): string {
  const deployLines = DEPLOY_OPTIONS.map(
    (o) =>
      `  - "${o.label}"${o.recommended ? " (recommended, and on by default)" : ""} — ${o.what} ${o.caution}`,
  ).join("\n");

  const domainLine = opts?.domain
    ? `I am setting up ${opts.domain}, so you don't need to ask me which domain.`
    : `I'll be typing my domain into the "${DOMAIN_STEP.label}" box (example: ${DOMAIN_STEP.placeholder}).`;

  return `You are helping me set up email on my own domain using MailPoppy — an app that runs a complete mail system inside my own AWS account. There is no mail provider in the middle: I own the mailboxes and the stored mail, and nobody else, including the people who wrote MailPoppy, can read it. I will describe, in my own words, who needs email addresses and what for. Your job: turn that into exactly what I should type and tick in MailPoppy's setup. If my description is ambiguous or missing something important, ask me at most three short questions first.

${domainLine}${opts?.region ? ` My AWS region is ${opts.region}.` : ""}

STEP 1 — THE DOMAIN:
- "${DOMAIN_STEP.label}" — ${DOMAIN_STEP.what}
- HARD PREREQUISITE, and the single most common way this goes wrong: ${DOMAIN_STEP.requirement} If what I've told you suggests my domain is at GoDaddy, Namecheap, Cloudflare, Wix, Squarespace or similar, say so FIRST and tell me the DNS move is step zero — don't walk me through the rest as if it will work.
- The DNS step itself: ${DOMAIN_STEP.dnsStep}
- If this domain currently receives mail somewhere else (Google Workspace, Microsoft 365, a host's webmail), warn me plainly that changing the MX records moves ALL incoming mail for the domain to MailPoppy, and that I should not do this on a domain I depend on until I've tested. Suggest a spare domain or a subdomain if what I described sounds like a live business address.

STEP 2 — TWO CHOICES WHEN THE MAIL SERVICE IS CREATED (both are on by default; leave them on unless there's a reason):
${deployLines}

STEP 3 — THE MAILBOXES:
- "${MAILBOX_FIELDS.address.label}" — ${MAILBOX_FIELDS.address.what}
- "${MAILBOX_FIELDS.password.label}" — ${MAILBOX_FIELDS.password.what} ${MAILBOX_FIELDS.password.policy} Suggest strong passwords, and tell me to put them in a password manager as I create each one — MailPoppy cannot show me a password again later.
- ${MAILBOX_FIELDS.gate}
- ${MAILBOX_FIELDS.existingMailWarning}

ALIASES AND CATCH-ALL — read this before recommending any:
- ${ALIASES.what}

MAILBOXES FOR AI AGENTS (only if what I described actually involves one):
- The trigger on a mailbox row is "${AGENT_MAILBOX.trigger}".
- ${AGENT_MAILBOX.prerequisiteFirst}
- ${AGENT_MAILBOX.what}
- ${AGENT_MAILBOX.privacyWarning}
- ${AGENT_MAILBOX.scope}
- The exact step, if I need one: ${AGENT_MAILBOX.crossPoppyStep}
- Recommend this ONLY when I've described wanting an address an AI assistant answers or acts on (a support@ that drafts replies, an address I forward tasks to). If everything I described is for people, say "not needed" and move on — don't upsell me a second app.

RULES OF THE PRODUCT — plan within these; never suggest working around them:
- Everything runs in MY AWS account. Nothing is stored on a vendor server, and no mail is ever sent to a third-party AI or service without me choosing it.
- MailPoppy asks me to confirm before it creates, changes or deletes anything in AWS, and it shows me exactly what it made. Deleting a mailbox or a domain needs me to type the name to confirm, and there is no trash or backup afterwards. Don't describe any of it as instant or reversible.
- Sell me on addresses, not seats: a domain gets unlimited mailboxes. Don't invent per-user pricing.
- A brand-new domain often lands in spam for the first week or two while its sending reputation builds. That's normal and improves on its own — say so, because otherwise I'll think it's broken.
- Attachments are capped at about 40 MB per message by AWS. Not configurable.
- Receiving mail is only supported in some AWS regions. If I ask for a specific region, say you can't promise it and that MailPoppy shows which region it's using.
- There is no "Sent" copy kept by the mail service for free, and "unique" per-mailbox storage limits are enforced by bouncing over-quota mail rather than silently dropping it.

ANSWER IN EXACTLY THIS SHAPE (the "…" are placeholders for you to fill in — not missing text):
1. Before we start: … (the DNS-hosting prerequisite as it applies to me, and whether the domain I named is safe to use — or "nothing blocking")
2. Domain to enter: …
3. The two tick boxes: … (leave both on, or which to change and why)
4. Mailboxes to create: … (a numbered list of the exact addresses, each with one line on who it's for; then a note if any of them are only wanted as aliases and therefore need their own mailbox)
5. Which mailbox, if any, should be assigned to an AI agent: … or "none"
6. In what order to do it: … (a short numbered checklist I can follow, including where waiting happens)
7. What to watch out for: … (the honest short list — spam reputation on a new domain, passwords I can't recover, mail moving away from my current provider)

THE LAST LINE BELOW IS DELIBERATELY UNFINISHED — nothing was cut off. I complete that sentence myself, in my own words, right after pasting this. If I've sent it still unfinished, don't treat this message as truncated: just ask me who needs email addresses on this domain, and what for.

MY MAILBOX SETUP SHOULD: `;
}
