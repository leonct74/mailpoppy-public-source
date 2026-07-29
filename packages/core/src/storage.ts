// Per-mailbox storage quota helpers, shared by the sidecar admin tools, the
// access API usage endpoint, and the inbound quota enforcement. A mailbox's
// usage is the sum of `sizeBytes` across its index rows (one per message).

export interface MailboxStorage {
  email: string;
  usedBytes: number;
  messageCount: number;
  quotaBytes: number | null; // null = no limit
}

/** Settings-table partition key holding a mailbox's quota item. */
export function quotaSettingsKey(address: string): string {
  return `quota#${address.trim().toLowerCase()}`;
}

/** Human-readable bytes, e.g. 1536 → "1.5 KB", 1.2e9 → "1.1 GB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Percentage of quota used (0–100+), or null when there is no quota. */
export function usagePercent(usedBytes: number, quotaBytes: number | null): number | null {
  if (!quotaBytes || quotaBytes <= 0) return null;
  return (usedBytes / quotaBytes) * 100;
}

export type UsageLevel = "ok" | "warn" | "full";

/** ok < 80% · warn 80–99% · full ≥ 100%. "ok" when there is no quota. */
export function usageLevel(usedBytes: number, quotaBytes: number | null): UsageLevel {
  const p = usagePercent(usedBytes, quotaBytes);
  if (p === null) return "ok";
  if (p >= 100) return "full";
  if (p >= 80) return "warn";
  return "ok";
}

/** Would storing `addBytes` more push the mailbox over its quota? */
export function wouldExceedQuota(usedBytes: number, addBytes: number, quotaBytes: number | null): boolean {
  if (!quotaBytes || quotaBytes <= 0) return false; // no limit
  return usedBytes + addBytes > quotaBytes;
}
