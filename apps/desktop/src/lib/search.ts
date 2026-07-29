// Client-side inbox search (DESIGN §14 / "search" gotcha): the free default is a
// local filter over the loaded folder page — no server cost, works offline. Deep
// full-history search (Athena opt-in) is a later, cost-bearing feature.
import type { MessageMeta } from "@mailpoppy/core";

/** Does a message match the query? AND of whitespace-separated tokens, case-insensitive. */
export function messageMatches(m: MessageMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    m.subject,
    m.snippet,
    m.from.name ?? "",
    m.from.address,
    ...m.to.map((t) => t.address),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

export function filterMessages(items: MessageMeta[], query: string): MessageMeta[] {
  if (!query.trim()) return items;
  return items.filter((m) => messageMatches(m, query));
}
