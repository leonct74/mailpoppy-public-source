import { describe, it, expect } from "vitest";
import {
  policySettingsKey,
  isValidListEntry,
  normalizeAddressList,
  normalizeSpamPolicy,
} from "./policy";
import { DEFAULT_POLICY } from "./types";

describe("policySettingsKey", () => {
  it("builds a normalized key with a default scope", () => {
    expect(policySettingsKey()).toBe("policy#default");
    expect(policySettingsKey("Ollydigital.com")).toBe("policy#ollydigital.com");
    expect(policySettingsKey("  ")).toBe("policy#default");
  });
});

describe("isValidListEntry", () => {
  it("accepts addresses, domains, and @domain", () => {
    for (const ok of ["alice@example.com", "example.com", "@example.com", "sub.example.co.uk"]) {
      expect(isValidListEntry(ok)).toBe(true);
    }
  });
  it("rejects junk", () => {
    for (const bad of ["", "   ", "nonsense", "no spaces here", "@", "example"]) {
      expect(isValidListEntry(bad)).toBe(false);
    }
  });
});

describe("normalizeAddressList", () => {
  it("trims, lowercases, drops empties, and dedupes (stable order)", () => {
    expect(normalizeAddressList([" A@B.com ", "a@b.com", "", "  ", "C@D.com"])).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });
  it("handles null/undefined", () => {
    expect(normalizeAddressList(null)).toEqual([]);
    expect(normalizeAddressList(undefined)).toEqual([]);
  });
});

describe("normalizeSpamPolicy", () => {
  it("returns defaults for empty input", () => {
    expect(normalizeSpamPolicy(null)).toEqual(DEFAULT_POLICY.spam);
    expect(normalizeSpamPolicy({})).toEqual(DEFAULT_POLICY.spam);
  });

  it("keeps valid actions and cleans lists", () => {
    expect(
      normalizeSpamPolicy({
        onVirus: "reject",
        onSpam: "tag",
        onAuthFail: "allow",
        allowList: ["Boss@WORK.com", "boss@work.com"],
        blockList: ["spam.example"],
      }),
    ).toEqual({
      onVirus: "reject",
      onSpam: "tag",
      onAuthFail: "allow",
      allowList: ["boss@work.com"],
      blockList: ["spam.example"],
    });
  });

  it("falls back to defaults for invalid actions (never breaks delivery)", () => {
    const p = normalizeSpamPolicy({
      onVirus: "inbox" as never, // not allowed — a virus must never inbox
      onSpam: "explode" as never,
      onAuthFail: "" as never,
    });
    expect(p.onVirus).toBe(DEFAULT_POLICY.spam.onVirus); // "quarantine"
    expect(p.onSpam).toBe(DEFAULT_POLICY.spam.onSpam); // "junk"
    expect(p.onAuthFail).toBe(DEFAULT_POLICY.spam.onAuthFail); // "junk"
  });
});
