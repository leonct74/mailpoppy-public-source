import { describe, it, expect } from "vitest";
import {
  defaultMailFromDomain,
  mailFromDnsRecords,
  mailFromAlignment,
  type MailFromState,
} from "./mailFrom";

describe("defaultMailFromDomain", () => {
  it("prefixes mail. and normalizes", () => {
    expect(defaultMailFromDomain("ollydigital.com")).toBe("mail.ollydigital.com");
    expect(defaultMailFromDomain("  OllyDigital.com.  ")).toBe("mail.ollydigital.com");
  });
});

describe("mailFromDnsRecords", () => {
  it("returns a region-specific feedback MX and an SPF TXT", () => {
    const recs = mailFromDnsRecords("mail.ollydigital.com", "eu-west-1");
    expect(recs).toEqual([
      { type: "MX", name: "mail.ollydigital.com", value: "10 feedback-smtp.eu-west-1.amazonses.com" },
      { type: "TXT", name: "mail.ollydigital.com", value: '"v=spf1 include:amazonses.com ~all"' },
    ]);
  });

  it("uses the given region in the MX host", () => {
    expect(mailFromDnsRecords("mail.x.com", "us-east-1")[0]!.value).toBe("10 feedback-smtp.us-east-1.amazonses.com");
  });
});

describe("mailFromAlignment", () => {
  const dom = "mail.ollydigital.com";
  it("is not-configured when no MAIL FROM domain is set", () => {
    expect(mailFromAlignment(null)).toBe("not-configured");
    expect(mailFromAlignment({ behaviorOnMxFailure: "USE_DEFAULT_VALUE" })).toBe("not-configured");
  });
  it("is aligned on SUCCESS", () => {
    expect(mailFromAlignment({ mailFromDomain: dom, status: "SUCCESS" })).toBe("aligned");
  });
  it("is failed on FAILED", () => {
    expect(mailFromAlignment({ mailFromDomain: dom, status: "FAILED" })).toBe("failed");
  });
  it("is pending while verifying", () => {
    const pendings: MailFromState[] = [
      { mailFromDomain: dom, status: "PENDING" },
      { mailFromDomain: dom, status: "TEMPORARY_FAILURE" },
      { mailFromDomain: dom },
    ];
    for (const s of pendings) expect(mailFromAlignment(s)).toBe("pending");
  });
});
