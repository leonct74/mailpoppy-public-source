// Mail retention settings (DESIGN §10). AWS never auto-deletes mail — it's kept
// until something deletes it — so retention is the admin's decision, and the law
// cuts both ways (minimum-retention rules vs. data-minimisation rules). The
// janitor Lambda enforces these on a schedule; the sidecar writes them; the UI
// edits them. Safe default: keep mail indefinitely, only auto-purge Trash.

export interface RetentionSettings {
  /** Purge messages in Trash older than this many days. Always on (deleted mail). */
  trashPurgeDays: number;
  /**
   * If set, hard-delete ANY message older than this many days, in every folder
   * (data-minimisation window). `null` = keep mail indefinitely (the safe default).
   */
  retentionDays: number | null;
}

export const DEFAULT_RETENTION: RetentionSettings = { trashPurgeDays: 30, retentionDays: null };

/** Settings-table partition key for the deployment's retention settings. */
export function retentionSettingsKey(scope = "default"): string {
  const s = scope.trim().toLowerCase() || "default";
  return `retention#${s}`;
}

function posIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/**
 * Coerce arbitrary/untrusted input into valid RetentionSettings. Used on write
 * (sidecar) and read (janitor) so a malformed doc can never cause surprise
 * deletion — worst case it falls back to "keep indefinitely, purge Trash at 30d".
 */
export function normalizeRetention(input: Partial<RetentionSettings> | null | undefined): RetentionSettings {
  const trashPurgeDays = posIntOr(input?.trashPurgeDays, DEFAULT_RETENTION.trashPurgeDays);
  const raw = input?.retentionDays;
  // null/undefined/0/negative/invalid → keep forever (null). A positive int sets the window.
  const retentionDays = raw === null || raw === undefined ? null : Number.isFinite(Number(raw)) && Number(raw) >= 1 ? Math.floor(Number(raw)) : null;
  return { trashPurgeDays, retentionDays };
}

/**
 * Pure retention decision used by the janitor: should this stored message be
 * hard-deleted now under `retention`? Deletes when (a) it's in Trash and older
 * than `trashPurgeDays`, or (b) a `retentionDays` window is set and it's older
 * than that (any folder). Fail-safe: an unparseable date is never deleted.
 */
export function shouldPurgeMessage(
  msg: { folder: string; date: string },
  retention: RetentionSettings,
  now: number = Date.now(),
): boolean {
  const ts = new Date(msg.date).getTime();
  if (!Number.isFinite(ts)) return false; // can't age an undateable row → keep it
  const ageDays = (now - ts) / 86_400_000;
  if (msg.folder === "trash" && ageDays > retention.trashPurgeDays) return true;
  if (retention.retentionDays !== null && ageDays > retention.retentionDays) return true;
  return false;
}
