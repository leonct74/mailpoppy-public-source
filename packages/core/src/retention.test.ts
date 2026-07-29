import { describe, it, expect } from "vitest";
import { retentionSettingsKey, normalizeRetention, shouldPurgeMessage, DEFAULT_RETENTION } from "./retention";

describe("retentionSettingsKey", () => {
  it("builds a normalized key", () => {
    expect(retentionSettingsKey()).toBe("retention#default");
    expect(retentionSettingsKey("  ")).toBe("retention#default");
  });

  it("scopes per-domain (case-insensitive)", () => {
    expect(retentionSettingsKey("Boxord.com")).toBe("retention#boxord.com");
  });
});

describe("shouldPurgeMessage", () => {
  const NOW = Date.parse("2026-06-01T00:00:00Z");
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

  it("keeps everything under the default keep-forever policy except old Trash", () => {
    const r = { trashPurgeDays: 30, retentionDays: null };
    expect(shouldPurgeMessage({ folder: "inbox", date: daysAgo(3650) }, r, NOW)).toBe(false);
    expect(shouldPurgeMessage({ folder: "trash", date: daysAgo(31) }, r, NOW)).toBe(true);
    expect(shouldPurgeMessage({ folder: "trash", date: daysAgo(10) }, r, NOW)).toBe(false);
  });

  it("enforces a retention window across every folder", () => {
    const r = { trashPurgeDays: 30, retentionDays: 365 };
    expect(shouldPurgeMessage({ folder: "inbox", date: daysAgo(400) }, r, NOW)).toBe(true);
    expect(shouldPurgeMessage({ folder: "inbox", date: daysAgo(100) }, r, NOW)).toBe(false);
    // Trash still purges on its own shorter clock.
    expect(shouldPurgeMessage({ folder: "trash", date: daysAgo(31) }, r, NOW)).toBe(true);
  });

  it("never deletes a row with an unparseable date (fail-safe)", () => {
    const r = { trashPurgeDays: 1, retentionDays: 1 };
    expect(shouldPurgeMessage({ folder: "inbox", date: "not-a-date" }, r, NOW)).toBe(false);
  });
});

describe("normalizeRetention", () => {
  it("defaults to keep-forever + 30d Trash purge", () => {
    expect(normalizeRetention(null)).toEqual(DEFAULT_RETENTION);
    expect(normalizeRetention({})).toEqual({ trashPurgeDays: 30, retentionDays: null });
  });

  it("keeps valid values (floored to whole days)", () => {
    expect(normalizeRetention({ trashPurgeDays: 7, retentionDays: 365 })).toEqual({ trashPurgeDays: 7, retentionDays: 365 });
    expect(normalizeRetention({ trashPurgeDays: 14.9, retentionDays: 90.6 })).toEqual({ trashPurgeDays: 14, retentionDays: 90 });
  });

  it("treats 0/negative/invalid retentionDays as keep-forever (never surprise-deletes)", () => {
    expect(normalizeRetention({ retentionDays: 0 }).retentionDays).toBeNull();
    expect(normalizeRetention({ retentionDays: -5 }).retentionDays).toBeNull();
    expect(normalizeRetention({ retentionDays: "nonsense" as never }).retentionDays).toBeNull();
  });

  it("falls back trashPurgeDays to the default when invalid", () => {
    expect(normalizeRetention({ trashPurgeDays: 0 }).trashPurgeDays).toBe(30);
    expect(normalizeRetention({ trashPurgeDays: -1 }).trashPurgeDays).toBe(30);
  });
});
