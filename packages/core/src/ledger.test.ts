import { describe, it, expect } from "vitest";
import { liveDomainIdentities, liveRecipientIdentities, type LedgerIdentityEntry } from "./ledger";

const e = (action: string, name: string, over: Partial<LedgerIdentityEntry> = {}): LedgerIdentityEntry => ({
  action,
  service: "SES",
  resourceType: "EmailIdentity",
  name,
  ...over,
});

describe("liveDomainIdentities", () => {
  it("returns the domains that were created and not later deleted", () => {
    expect(
      liveDomainIdentities([e("created", "ollydigital.com"), e("created", "boxord.com"), e("deleted", "boxord.com")]),
    ).toEqual(["ollydigital.com"]);
  });

  // THE field bug (2026-08-23, shipped in 0.1.19): verifying a personal address as a
  // sandbox test recipient registered "gmail.com" as a hosted domain — visible on the
  // dashboard, and fed into teardown's DNS cleanup for a domain the admin never asked
  // MailPoppy to touch. An address identity is a RECIPIENT, never a domain.
  it("never turns a verified test recipient into a domain", () => {
    const entries = [e("created", "ollydigital.com"), e("created", "you@gmail.com")];
    expect(liveDomainIdentities(entries)).toEqual(["ollydigital.com"]);
    expect(liveDomainIdentities(entries)).not.toContain("gmail.com");
  });

  it("ignores rows from other services and resource types", () => {
    expect(
      liveDomainIdentities([
        e("created", "ollydigital.com"),
        e("created", "mail.ollydigital.com", { service: "Route53", resourceType: "DNS" }),
        e("created", "mailpoppy-rules", { resourceType: "ReceiptRuleSet" }),
      ]),
    ).toEqual(["ollydigital.com"]);
  });

  it("normalises case/whitespace and skips empty names", () => {
    expect(liveDomainIdentities([e("created", "  OllyDigital.COM  "), e("created", "")])).toEqual(["ollydigital.com"]);
  });

  it("replays chronologically, so a re-created domain is live again", () => {
    expect(
      liveDomainIdentities([e("created", "a.com"), e("deleted", "a.com"), e("created", "a.com")]),
    ).toEqual(["a.com"]);
  });
});

describe("liveRecipientIdentities", () => {
  it("is the exact complement — addresses only, never domains", () => {
    const entries = [e("created", "ollydigital.com"), e("created", "you@gmail.com"), e("created", "me@work.com")];
    expect(liveRecipientIdentities(entries)).toEqual(["me@work.com", "you@gmail.com"]);
    // Every EmailIdentity row lands in exactly one of the two buckets.
    const both = [...liveDomainIdentities(entries), ...liveRecipientIdentities(entries)];
    expect(both.sort()).toEqual(["me@work.com", "ollydigital.com", "you@gmail.com"]);
  });

  it("drops a recipient a later entry deleted", () => {
    expect(liveRecipientIdentities([e("created", "you@gmail.com"), e("deleted", "you@gmail.com")])).toEqual([]);
  });
});
