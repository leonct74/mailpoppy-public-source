import { describe, expect, it } from "vitest";
import { daysLeft, trialCountdownLabel } from "./commerce";

// The trial countdown is the one piece of billing UI that states a number to the user, so it gets
// pinned: an off-by-one here means telling someone their trial ends a day later than it does.
describe("daysLeft", () => {
  const now = Date.UTC(2026, 6, 31, 12, 0, 0); // 2026-07-31 12:00 UTC
  const DAY = 86_400_000;

  it("rounds UP so a part-day still counts as a day", () => {
    // 6 days and 1 hour out — the user has 'seven' calendar days of access left, not six.
    expect(daysLeft(now + 6 * DAY + 3_600_000, now)).toBe(7);
    expect(daysLeft(now + 6 * DAY, now)).toBe(6);
  });

  it("counts a fresh 7-day trial as 7", () => {
    expect(daysLeft(now + 7 * DAY, now)).toBe(7);
  });

  it("never goes negative once the trial has passed", () => {
    expect(daysLeft(now - DAY, now)).toBe(0);
    expect(daysLeft(now - 500 * DAY, now)).toBe(0);
  });

  it("returns null when there is no usable date (older API, missing field, junk)", () => {
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft(undefined, now)).toBeNull();
    expect(daysLeft(Number.NaN, now)).toBeNull();
    expect(daysLeft(Number.POSITIVE_INFINITY, now)).toBeNull();
  });
});

describe("trialCountdownLabel", () => {
  it("singularises one day", () => {
    expect(trialCountdownLabel(1)).toBe("1 day left");
    expect(trialCountdownLabel(7)).toBe("7 days left");
  });

  it("says 'ends today' rather than '0 days left'", () => {
    expect(trialCountdownLabel(0)).toBe("ends today");
  });

  it("passes null through, so the banner hides instead of showing a blank countdown", () => {
    expect(trialCountdownLabel(null)).toBeNull();
  });
});
