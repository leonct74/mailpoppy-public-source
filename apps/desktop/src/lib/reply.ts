// Pure helpers for replying / forwarding (Phase 3, DESIGN §9.2). Produces the
// prefilled compose state — recipients, subject, quoted body — and the RFC 5322
// threading headers (In-Reply-To / References) so replies stay in-thread. The
// backend send path (access-api → SESv2 Simple+Headers) already accepts these.
import type { MessageMeta } from "@mailpoppy/core";

export type ReplyMode = "reply" | "replyAll" | "forward";

export interface ComposeInit {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}

const bare = (id: string) => id.trim().replace(/^<|>$/g, "");
const angle = (id: string) => `<${bare(id)}>`;

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject}`.trim();
}

export function forwardSubject(subject: string): string {
  return /^fwd?:/i.test(subject.trim()) ? subject.trim() : `Fwd: ${subject}`.trim();
}

/** Unique, case-insensitive, excluding the mailbox's own address. */
function recipientsExcludingSelf(addresses: string[], self: string): string[] {
  const seen = new Set<string>();
  const me = self.trim().toLowerCase();
  const out: string[] = [];
  for (const a of addresses) {
    const norm = a.trim().toLowerCase();
    if (!norm || norm === me || seen.has(norm)) continue;
    seen.add(norm);
    out.push(a.trim());
  }
  return out;
}

function quoteBlock(meta: MessageMeta, body: string): string {
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `\n\nOn ${meta.date}, ${meta.from.address} wrote:\n${quoted}`;
}

/**
 * Build the prefilled compose state for a reply / reply-all / forward.
 * `self` is the mailbox's own address (excluded from reply-all). `quotedBody`
 * is the original message text to quote (falls back to the snippet).
 */
export function buildReply(
  meta: MessageMeta,
  mode: ReplyMode,
  opts: { self: string; quotedBody?: string },
): ComposeInit {
  const body = opts.quotedBody ?? meta.snippet ?? "";

  if (mode === "forward") {
    const header =
      `\n\n---------- Forwarded message ----------\n` +
      `From: ${meta.from.address}\n` +
      `Date: ${meta.date}\n` +
      `Subject: ${meta.subject}\n` +
      `To: ${meta.to.map((t) => t.address).join(", ")}\n\n`;
    return { to: [], subject: forwardSubject(meta.subject), text: header + body };
  }

  const candidates =
    mode === "replyAll"
      ? [meta.from.address, ...meta.to.map((t) => t.address)]
      : [meta.from.address];

  // References = the thread root (+ the message we're replying to).
  const refs = meta.threadId && bare(meta.threadId) !== bare(meta.messageId)
    ? `${angle(meta.threadId)} ${angle(meta.messageId)}`
    : angle(meta.messageId);

  return {
    to: recipientsExcludingSelf(candidates, opts.self),
    subject: replySubject(meta.subject),
    inReplyTo: angle(meta.messageId),
    references: refs,
    text: quoteBlock(meta, body),
  };
}
