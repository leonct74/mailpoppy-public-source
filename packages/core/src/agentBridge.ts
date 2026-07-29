// The MailPoppy ↔ CrewPoppy bridge (spec: mission-control-poppy/docs/
// mailpoppy-bridge-spec.md, v1). A mailbox can be flagged AGENT-OWNED: mail
// arriving for it is COPIED to CrewPoppy's runner Lambda (fixed function name,
// same account + region) so an email can start an agent run — while normal
// delivery to the mailbox is untouched. This module holds the pure halves shared
// by the inbound Lambda and the admin sidecar: the settings key for the flag and
// the wire-contract payload builder. The payload is a CONTRACT — CrewPoppy
// implements its receiving half against exactly this shape, so changes here are
// breaking changes for another product.
import type { AuthVerdicts } from "./types";

/** The fixed name of CrewPoppy's runner Lambda — the cross-poppy wire contract. */
export const CREWPOPPY_RUNNER_FUNCTION = "CrewPoppyRunner";

/** Settings-table partition key holding a mailbox's agent-owned flag. */
export function agentOwnedSettingsKey(address: string): string {
  return `agent#${address.trim().toLowerCase()}`;
}

/** Hard cap on the plain-text body forwarded to the agent (spec §3). */
export const AGENT_TEXT_MAX_CHARS = 20_000;

/**
 * The v1 hand-off payload. Attachments are deliberately absent (a future field,
 * not an omission) — do not add fields without versioning the contract with the
 * CrewPoppy side. `verdicts` MUST be SES's real receipt verdicts, never
 * synthesized: CrewPoppy's runner refuses to act on mail that isn't fully
 * authenticated, and that gate is only as good as these values.
 */
export interface AgentMailPayload {
  kind: "mail";
  to: string;
  from: string;
  subject: string;
  text: string;
  messageId: string;
  receivedAt: string;
  verdicts: { spf: string; dkim: string; spam: string; virus: string };
}

/**
 * Reduce an HTML body to readable plain text: drop style/script blocks, turn
 * structural closers into newlines, strip the remaining tags, decode the common
 * entities. Deliberately simple — the agent needs the words, not the layout.
 */
export function htmlToAgentText(html: string): string {
  if (!html) return "";
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The plain-text body to forward: prefer the text part, else convert the HTML;
 *  always truncated to AGENT_TEXT_MAX_CHARS. */
export function agentMailText(text: string | undefined, html: string | undefined): string {
  const plain = (text ?? "").trim();
  const source = plain || htmlToAgentText(html ?? "");
  return source.length > AGENT_TEXT_MAX_CHARS ? source.slice(0, AGENT_TEXT_MAX_CHARS) : source;
}

/** Build the v1 hand-off payload from parsed inbound mail + SES's real verdicts. */
export function buildAgentMailPayload(input: {
  to: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  messageId: string;
  receivedAt: string;
  verdicts: AuthVerdicts;
}): AgentMailPayload {
  // GRAY is what SES verdict mapping already uses for "not evaluated" — honest
  // "unknown", never a synthesized PASS (CrewPoppy drops anything not PASS).
  const v = (x: string | undefined) => (x ?? "GRAY").toUpperCase();
  return {
    kind: "mail",
    to: input.to.trim().toLowerCase(),
    from: input.from.trim().toLowerCase(),
    subject: input.subject,
    text: agentMailText(input.text, input.html),
    messageId: input.messageId,
    receivedAt: input.receivedAt,
    verdicts: {
      spf: v(input.verdicts.spf),
      dkim: v(input.verdicts.dkim),
      spam: v(input.verdicts.spam),
      virus: v(input.verdicts.virus),
    },
  };
}
