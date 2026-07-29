// Inbox caching for the desktop webmail — the same stale-while-revalidate pattern
// the mobile app uses, so folder switches and message re-opens feel instant instead
// of spinner-driven.
//
// Two caches with deliberately different lifetimes:
//  - LIST cache (localStorage): per mailbox+folder message metadata, survives app
//    restarts. Metadata only (sender/subject/snippet) — small and quota-safe.
//  - MESSAGE cache (in-memory LRU): full EMLs as displayed (i.e. already decrypted
//    for encrypted mail). Kept OFF disk on purpose: plaintext of encrypted mail must
//    never be persisted, and localStorage's ~5MB quota can't hold bodies anyway.
//    Emails are immutable, so a hit needs zero network and zero decryption.
//
// Callers skip caching entirely in demo mode (no mailbox identity to key by).
import type { Folder, MessageMeta } from "@mailpoppy/core";

const LIST_PREFIX = "mailpoppy.inboxCache.";
/** Cap persisted list entries — enough for the visible list, small enough for quota. */
export const MAX_LIST_ITEMS = 50;

function listKey(mailbox: string, folder: Folder): string {
  return `${LIST_PREFIX}${mailbox.trim().toLowerCase()}.${folder}`;
}

/** The cached list for a mailbox+folder, or null (miss / storage unavailable). */
export function loadListCache(mailbox: string, folder: Folder): MessageMeta[] | null {
  try {
    const raw = localStorage.getItem(listKey(mailbox, folder));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { items?: MessageMeta[] };
    return Array.isArray(parsed.items) ? parsed.items : null;
  } catch {
    return null; // corrupt entry or storage blocked — treat as a miss
  }
}

export function saveListCache(mailbox: string, folder: Folder, items: MessageMeta[]): void {
  try {
    localStorage.setItem(
      listKey(mailbox, folder),
      JSON.stringify({ items: items.slice(0, MAX_LIST_ITEMS), at: Date.now() }),
    );
  } catch {
    /* quota/privacy mode — caching is best-effort */
  }
}

/** Drop every cached list (sign-out: the next user must never see this mailbox). */
export function clearListCaches(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LIST_PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

// ---- In-memory message (EML) cache ------------------------------------------

/** Keep the most recently read messages this session. */
export const MAX_CACHED_MESSAGES = 30;
/** Skip caching giant bodies so 30 entries can't balloon memory. */
export const MAX_EML_CHARS = 300_000;

// Map preserves insertion order — delete+set on read makes it an LRU.
const emlCache = new Map<string, string>();

/** The displayed (decrypted) EML for a message, or null on a miss. */
export function loadCachedEml(messageId: string): string | null {
  const hit = emlCache.get(messageId);
  if (hit === undefined) return null;
  emlCache.delete(messageId);
  emlCache.set(messageId, hit); // refresh recency
  return hit;
}

export function saveCachedEml(messageId: string, eml: string): void {
  if (eml.length > MAX_EML_CHARS) return;
  emlCache.delete(messageId);
  emlCache.set(messageId, eml);
  while (emlCache.size > MAX_CACHED_MESSAGES) {
    const oldest = emlCache.keys().next().value;
    if (oldest === undefined) break;
    emlCache.delete(oldest);
  }
}

export function clearMessageCache(): void {
  emlCache.clear();
}

/** Everything at once — the sign-out hook. */
export function clearMailCaches(): void {
  clearListCaches();
  clearMessageCache();
}
