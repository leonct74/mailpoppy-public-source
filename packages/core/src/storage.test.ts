import { describe, it, expect } from "vitest";
import { quotaSettingsKey, formatBytes, usagePercent, usageLevel, wouldExceedQuota } from "./storage";

const GB = 1024 ** 3;

describe("storage quota helpers", () => {
  it("builds a normalized settings key", () => {
    expect(quotaSettingsKey("Marco@Olly.com")).toBe("quota#marco@olly.com");
  });

  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(GB)).toBe("1.0 GB");
  });

  it("computes usage percent (null when no quota)", () => {
    expect(usagePercent(GB / 10, GB)).toBeCloseTo(10);
    expect(usagePercent(GB, GB)).toBe(100);
    expect(usagePercent(100, null)).toBeNull();
    expect(usagePercent(100, 0)).toBeNull();
  });

  it("classifies usage level", () => {
    expect(usageLevel(GB / 2, GB)).toBe("ok");
    expect(usageLevel(GB * 0.85, GB)).toBe("warn");
    expect(usageLevel(GB, GB)).toBe("full");
    expect(usageLevel(GB * 2, GB)).toBe("full");
    expect(usageLevel(GB, null)).toBe("ok"); // no limit
  });

  it("decides whether a new message would exceed the quota", () => {
    expect(wouldExceedQuota(GB - 100, 50, GB)).toBe(false);
    expect(wouldExceedQuota(GB - 100, 200, GB)).toBe(true);
    expect(wouldExceedQuota(GB * 5, 1, null)).toBe(false); // no limit
  });
});
