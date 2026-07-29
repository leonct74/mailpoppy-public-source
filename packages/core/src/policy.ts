// Admin spam/auth policy persistence + normalization (DESIGN §10).
//
// The inbound-processor already routes mail via `classifyDelivery(sender, verdicts,
// policy)` (mailbox.ts) — block-list → allow-list → virus → spam → auth → clean.
// What was missing is a place to STORE the admin's policy and helpers to keep it
// clean. The policy lives as one JSON doc in the settings table (key below); the
// sidecar writes it, the inbound-processor reads it.

import type { SpamPolicy } from "./types";
import { DEFAULT_POLICY } from "./types";

/** Settings-table partition key for the deployment policy (per-domain override later). */
export function policySettingsKey(scope = "default"): string {
  const s = scope.trim().toLowerCase() || "default";
  return `policy#${s}`;
}

const VIRUS_ACTIONS = ["reject", "quarantine"] as const;
const SPAM_ACTIONS = ["junk", "tag", "reject"] as const;
const AUTH_ACTIONS = ["junk", "tag", "reject", "allow"] as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DOMAIN_RE = /^@?[^@\s.]+(?:\.[^@\s.]+)+$/;

/**
 * Is `raw` a usable allow/block entry? Accepts a full address ("a@b.com"), a bare
 * domain ("b.com"), or an "@domain" form ("@b.com"). Used by the UI to warn; an
 * invalid entry is harmless (it simply never matches).
 */
export function isValidListEntry(raw: string): boolean {
  const e = raw.trim().toLowerCase();
  if (!e) return false;
  return EMAIL_RE.test(e) || DOMAIN_RE.test(e);
}

/** Trim + lowercase a single list entry (keeps address/domain/@domain forms). */
export function normalizeListEntry(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Clean a list: trim/lowercase each, drop empties, dedupe (stable order). */
export function normalizeAddressList(list: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of list ?? []) {
    const v = normalizeListEntry(e);
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Coerce arbitrary/untrusted input into a valid SpamPolicy, defaulting per field.
 * Used on both write (sidecar) and read (Lambda) so a malformed stored doc can
 * never break delivery — worst case it falls back to safe defaults.
 */
export function normalizeSpamPolicy(input: Partial<SpamPolicy> | null | undefined): SpamPolicy {
  const d = DEFAULT_POLICY.spam;
  return {
    onVirus: pick(input?.onVirus, VIRUS_ACTIONS, d.onVirus),
    onSpam: pick(input?.onSpam, SPAM_ACTIONS, d.onSpam),
    onAuthFail: pick(input?.onAuthFail, AUTH_ACTIONS, d.onAuthFail),
    allowList: normalizeAddressList(input?.allowList),
    blockList: normalizeAddressList(input?.blockList),
  };
}
