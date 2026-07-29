// Pure helpers for migrating existing mail (WorkMail / any IMAP server) into a
// Mailpoppy mailbox. The IO (IMAP fetch, S3/DynamoDB writes) lives in the desktop
// sidecar; the regression-prone *mapping* rules live here so they can be
// unit-tested in isolation and reused by a future server-side importer.
// See DESIGN §18 (Phase 4).

import type { Folder, MessageFlags } from "./types";

// IMAP "special-use" attributes (RFC 6154) are the most reliable signal for what
// a folder is, independent of its display name / language.
const SPECIAL_USE: Record<string, Folder> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "archive", // Gmail "All Mail" → archive
  "\\flagged": "inbox", // a virtual flagged view; fall back to inbox
};

// Name heuristics (case-insensitive) for servers that don't advertise
// special-use. Covers WorkMail / Outlook / Gmail / Dovecot conventions.
const NAME_RULES: Array<[RegExp, Folder]> = [
  [/^inbox$/i, "inbox"],
  [/sent(\s|-|_)?(items|messages|mail)?$/i, "sent"],
  [/^drafts?$/i, "drafts"],
  [/(deleted(\s|-|_)?(items|messages)?|trash|bin|papierkorb|corbeille|prullenbak)/i, "trash"],
  [/(junk|spam|bulk)/i, "junk"],
  [/(archive|all\s?mail|archief)/i, "archive"],
];

/**
 * Sanitize an arbitrary IMAP folder name into a Mailpoppy custom-folder token.
 * Critically strips "#" — that's our DynamoDB sort-key separator
 * (`folder#date#id`), so a folder named "a#b" would corrupt key parsing.
 */
export function sanitizeFolderName(name: string): Folder {
  const cleaned = (name || "folder")
    .toLowerCase()
    .replace(/[#]/g, "") // never allow our SK separator in a folder token
    .replace(/[\s/.\\]+/g, "-") // collapse hierarchy delimiters + whitespace
    .replace(/[^a-z0-9._-]/g, "") // drop anything else odd
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || "folder";
}

/**
 * Map an IMAP folder to a Mailpoppy {@link Folder}. Prefers the special-use
 * attribute; falls back to name heuristics; otherwise preserves the original
 * name as a sanitized custom folder (lossless — no mail is silently dropped or
 * merged into the inbox).
 */
export function mapImapFolder(name: string, specialUse?: string | null): Folder {
  const su = (specialUse ?? "").trim().toLowerCase();
  if (su && SPECIAL_USE[su]) return SPECIAL_USE[su];

  const base = (name ?? "").split(/[/.]/).pop() ?? name ?? "";
  // INBOX is special-cased by the protocol regardless of hierarchy.
  if (/^inbox$/i.test((name ?? "").trim())) return "inbox";
  for (const [re, folder] of NAME_RULES) {
    if (re.test(base) || re.test(name ?? "")) return folder;
  }
  return sanitizeFolderName(base || name || "folder");
}

/**
 * Translate IMAP system flags into Mailpoppy {@link MessageFlags}. Optional
 * fields are only set when true so migrated rows stay clean (and marshal without
 * a pile of `false`s). `\Seen` → read; `\Flagged` → starred; `\Answered` → answered.
 */
export function imapFlagsToFlags(flags: Iterable<string>): MessageFlags {
  const set = new Set<string>();
  for (const f of flags) set.add(String(f).trim().toLowerCase());
  const has = (f: string) => set.has(f);

  const result: MessageFlags = { unread: !has("\\seen") };
  if (has("\\flagged")) result.starred = true;
  if (has("\\answered")) result.answered = true;
  return result;
}

/**
 * Is this IMAP message one we should skip during migration? Messages marked
 * `\Deleted` are pending expunge on the source server — importing them would
 * resurrect mail the user already discarded.
 */
export function isImapDeleted(flags: Iterable<string>): boolean {
  for (const f of flags) {
    if (String(f).trim().toLowerCase() === "\\deleted") return true;
  }
  return false;
}
