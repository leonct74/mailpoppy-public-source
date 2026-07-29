import { describe, it, expect } from "vitest";
import {
  normalizeAddress,
  addressDomain,
  mailboxPk,
  messageSk,
  parseSk,
  folderPrefix,
  attachmentS3Key,
  deriveThreadId,
  mapVerdict,
  addressMatchesList,
  isKnownMailbox,
  classifyDelivery,
} from "./mailbox";
import { DEFAULT_POLICY, type DeploymentPolicy, type AuthVerdicts } from "./types";

const CLEAN: AuthVerdicts = {
  spam: "PASS",
  virus: "PASS",
  spf: "PASS",
  dkim: "PASS",
  dmarc: "PASS",
};

describe("normalizeAddress", () => {
  it("extracts the bare address from a display-name form", () => {
    expect(normalizeAddress("Alice Example <Alice@Example.com>")).toBe("alice@example.com");
  });
  it("trims, lowercases and strips angle brackets", () => {
    expect(normalizeAddress("  <BOB@Example.COM> ")).toBe("bob@example.com");
  });
  it("returns empty string for nullish input", () => {
    expect(normalizeAddress(null)).toBe("");
    expect(normalizeAddress(undefined)).toBe("");
    expect(normalizeAddress("")).toBe("");
  });
});

describe("addressDomain", () => {
  it("returns the domain part", () => {
    expect(addressDomain("you@ollydigital.com")).toBe("ollydigital.com");
  });
  it("returns empty string when there is no @", () => {
    expect(addressDomain("not-an-address")).toBe("");
  });
});

describe("key derivation", () => {
  it("derives a deterministic mailbox pk from the address alone", () => {
    expect(mailboxPk("You@OllyDigital.com")).toBe("ollydigital.com#you@ollydigital.com");
  });
  it("builds and parses a sort key round-trip", () => {
    const sk = messageSk("inbox", "2026-06-02T10:00:00.000Z", "<abc@ses>");
    expect(sk).toBe("inbox#2026-06-02T10:00:00.000Z#<abc@ses>");
    expect(parseSk(sk)).toEqual({
      folder: "inbox",
      date: "2026-06-02T10:00:00.000Z",
      messageId: "<abc@ses>",
    });
  });
  it("preserves a messageId that itself contains a separator", () => {
    const sk = messageSk("sent", "2026-06-02T10:00:00.000Z", "weird#id#here");
    expect(parseSk(sk).messageId).toBe("weird#id#here");
  });
  it("folderPrefix matches the start of its sort keys", () => {
    const sk = messageSk("trash", "2026-06-02T10:00:00.000Z", "m1");
    expect(sk.startsWith(folderPrefix("trash"))).toBe(true);
    expect(sk.startsWith(folderPrefix("inbox"))).toBe(false);
  });
  it("throws on a malformed sort key", () => {
    expect(() => parseSk("inbox-only")).toThrow();
  });

  it("builds a safe attachment key, sanitizing the filename", () => {
    expect(attachmentS3Key("ses-1", 0, "report.pdf")).toBe("attachments/ses-1/0-report.pdf");
    expect(attachmentS3Key("ses-1", 1, "../../etc/passwd")).toBe("attachments/ses-1/1-.._.._etc_passwd");
    expect(attachmentS3Key("ses-1", 2, "")).toBe("attachments/ses-1/2-attachment");
  });
});

describe("deriveThreadId", () => {
  it("uses the first References id when present", () => {
    expect(
      deriveThreadId({ references: "<root@x> <reply1@x>", inReplyTo: "<reply1@x>", messageId: "<reply2@x>" }),
    ).toBe("root@x");
  });
  it("accepts References as an array", () => {
    expect(deriveThreadId({ references: ["<root@x>", "<reply1@x>"] })).toBe("root@x");
  });
  it("falls back to In-Reply-To, then to its own Message-ID", () => {
    expect(deriveThreadId({ inReplyTo: "<parent@x>" })).toBe("parent@x");
    expect(deriveThreadId({ messageId: "<self@x>" })).toBe("self@x");
  });
});

describe("mapVerdict", () => {
  it("maps known statuses", () => {
    expect(mapVerdict("PASS")).toBe("PASS");
    expect(mapVerdict("fail")).toBe("FAIL");
    expect(mapVerdict("PROCESSING_FAILED")).toBe("PROCESSING_FAILED");
  });
  it("treats DISABLED / unknown / empty as GRAY", () => {
    expect(mapVerdict("DISABLED")).toBe("GRAY");
    expect(mapVerdict("")).toBe("GRAY");
    expect(mapVerdict(undefined)).toBe("GRAY");
    expect(mapVerdict("something-new")).toBe("GRAY");
  });
});

describe("addressMatchesList", () => {
  it("matches full address, bare domain and @domain forms", () => {
    expect(addressMatchesList("a@x.com", ["a@x.com"])).toBe(true);
    expect(addressMatchesList("a@x.com", ["x.com"])).toBe(true);
    expect(addressMatchesList("a@x.com", ["@x.com"])).toBe(true);
    expect(addressMatchesList("a@x.com", ["b@x.com", "y.com"])).toBe(false);
  });
  it("is case-insensitive and ignores empty entries", () => {
    expect(addressMatchesList("A@X.com", ["a@x.COM"])).toBe(true);
    expect(addressMatchesList("a@x.com", ["", "  "])).toBe(false);
  });
});

describe("isKnownMailbox", () => {
  const known = ["marco@ollydigital.com", "Anna@Ollydigital.com"];
  it("matches a real mailbox case-insensitively", () => {
    expect(isKnownMailbox("marco@ollydigital.com", known)).toBe(true);
    expect(isKnownMailbox("MARCO@OLLYDIGITAL.COM", known)).toBe(true);
    expect(isKnownMailbox("anna@ollydigital.com", known)).toBe(true);
  });
  it("rejects an unknown address", () => {
    expect(isKnownMailbox("info@ollydigital.com", known)).toBe(false);
    expect(isKnownMailbox("", known)).toBe(false);
    expect(isKnownMailbox("marco@ollydigital.com", [])).toBe(false);
  });
});

describe("classifyDelivery", () => {
  it("delivers clean, authenticated mail to the inbox", () => {
    expect(classifyDelivery("s@ext.com", CLEAN, DEFAULT_POLICY)).toEqual({
      folder: "inbox",
      reason: "clean",
    });
  });

  it("block-list wins over everything, even a clean verdict", () => {
    const policy: DeploymentPolicy = {
      ...DEFAULT_POLICY,
      spam: { ...DEFAULT_POLICY.spam, blockList: ["spammer.com"] },
    };
    expect(classifyDelivery("x@spammer.com", CLEAN, policy)).toEqual({
      folder: null,
      reason: "block-list",
    });
  });

  it("allow-list forces the inbox even when auth fails", () => {
    const policy: DeploymentPolicy = {
      ...DEFAULT_POLICY,
      spam: { ...DEFAULT_POLICY.spam, allowList: ["@partner.com"] },
    };
    const v: AuthVerdicts = { ...CLEAN, dmarc: "FAIL", spf: "FAIL" };
    expect(classifyDelivery("ceo@partner.com", v, policy)).toEqual({
      folder: "inbox",
      reason: "allow-list",
    });
  });

  it("never inboxes a virus (default policy quarantines to junk)", () => {
    const v: AuthVerdicts = { ...CLEAN, virus: "FAIL" };
    expect(classifyDelivery("s@ext.com", v, DEFAULT_POLICY).folder).toBe("junk");
  });

  it("rejects a virus when policy says reject", () => {
    const policy: DeploymentPolicy = {
      ...DEFAULT_POLICY,
      spam: { ...DEFAULT_POLICY.spam, onVirus: "reject" },
    };
    const v: AuthVerdicts = { ...CLEAN, virus: "FAIL" };
    expect(classifyDelivery("s@ext.com", v, policy).folder).toBeNull();
  });

  it("routes spam to junk under the default policy", () => {
    const v: AuthVerdicts = { ...CLEAN, spam: "FAIL" };
    expect(classifyDelivery("s@ext.com", v, DEFAULT_POLICY)).toEqual({
      folder: "junk",
      reason: "spam",
    });
  });

  it("routes auth failures to junk under the default policy", () => {
    const v: AuthVerdicts = { ...CLEAN, dkim: "FAIL" };
    expect(classifyDelivery("s@ext.com", v, DEFAULT_POLICY)).toEqual({
      folder: "junk",
      reason: "auth-fail",
    });
  });

  it("can tag auth failures into the inbox instead of junk", () => {
    const policy: DeploymentPolicy = {
      ...DEFAULT_POLICY,
      spam: { ...DEFAULT_POLICY.spam, onAuthFail: "tag" },
    };
    const v: AuthVerdicts = { ...CLEAN, dmarc: "FAIL" };
    expect(classifyDelivery("s@ext.com", v, policy)).toEqual({
      folder: "inbox",
      reason: "auth-fail",
    });
  });
});
