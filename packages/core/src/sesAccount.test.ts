import { describe, it, expect } from "vitest";
import {
  sendingAccessState,
  isSandboxed,
  validateProductionAccessRequest,
  recipientVerificationState,
  isUnverifiedRecipientError,
  productionAccessErrorMessage,
  MIN_USE_CASE_CHARS,
  type SesAccountStatus,
  type ProductionAccessRequest,
} from "./sesAccount";

const base: SesAccountStatus = { productionAccessEnabled: false, sendingEnabled: true };

describe("sendingAccessState", () => {
  it("is production when production access is enabled (regardless of review status)", () => {
    expect(sendingAccessState({ ...base, productionAccessEnabled: true })).toBe("production");
    expect(sendingAccessState({ ...base, productionAccessEnabled: true, reviewStatus: "GRANTED" })).toBe("production");
  });

  it("is pending while a request is under review", () => {
    expect(sendingAccessState({ ...base, reviewStatus: "PENDING" })).toBe("pending");
  });

  it("is denied when AWS denied or failed the request", () => {
    expect(sendingAccessState({ ...base, reviewStatus: "DENIED" })).toBe("denied");
    expect(sendingAccessState({ ...base, reviewStatus: "FAILED" })).toBe("denied");
  });

  it("is disabled when sending is paused (enforcement)", () => {
    expect(sendingAccessState({ ...base, sendingEnabled: false })).toBe("disabled");
  });

  it("is sandbox by default", () => {
    expect(sendingAccessState(base)).toBe("sandbox");
  });

  it("is unknown without data", () => {
    expect(sendingAccessState(null)).toBe("unknown");
    expect(sendingAccessState(undefined)).toBe("unknown");
  });

  it("isSandboxed only frees up once production is granted", () => {
    expect(isSandboxed(base)).toBe(true); // sandbox
    expect(isSandboxed({ ...base, reviewStatus: "PENDING" })).toBe(true);
    expect(isSandboxed({ ...base, reviewStatus: "DENIED" })).toBe(true);
    expect(isSandboxed({ ...base, productionAccessEnabled: true })).toBe(false);
  });
});

describe("validateProductionAccessRequest", () => {
  const ok: ProductionAccessRequest = {
    mailType: "TRANSACTIONAL",
    websiteUrl: "https://ollydigital.com",
    useCaseDescription: "Hosting our own company email for staff on ollydigital.com — normal business correspondence.",
    contactLanguage: "EN",
  };

  it("accepts a complete, sensible request", () => {
    expect(validateProductionAccessRequest(ok)).toEqual([]);
  });

  it("flags a missing/empty request", () => {
    expect(validateProductionAccessRequest(null).length).toBeGreaterThan(0);
  });

  it("requires a valid mail type and language", () => {
    const problems = validateProductionAccessRequest({ ...ok, mailType: "SPAM" as never, contactLanguage: "DE" as never });
    expect(problems.some((p) => /mail type/i.test(p))).toBe(true);
    expect(problems.some((p) => /language/i.test(p))).toBe(true);
  });

  it("requires a real URL", () => {
    expect(validateProductionAccessRequest({ ...ok, websiteUrl: "ollydigital" }).some((p) => /URL/i.test(p))).toBe(true);
    expect(validateProductionAccessRequest({ ...ok, websiteUrl: "https://ollydigital.com" })).toEqual([]);
  });

  it("requires a meaningful use-case description", () => {
    const problems = validateProductionAccessRequest({ ...ok, useCaseDescription: "email" });
    expect(problems.some((p) => p.includes(String(MIN_USE_CASE_CHARS)))).toBe(true);
  });

  it("validates each additional contact email", () => {
    const problems = validateProductionAccessRequest({ ...ok, additionalContactEmails: ["good@x.com", "nope"] });
    expect(problems.some((p) => /not a valid email/i.test(p))).toBe(true);
    expect(validateProductionAccessRequest({ ...ok, additionalContactEmails: ["a@b.com"] })).toEqual([]);
  });
});

describe("recipientVerificationState", () => {
  it("is not-started with no identity data", () => {
    expect(recipientVerificationState(null)).toBe("not-started");
    expect(recipientVerificationState(undefined)).toBe("not-started");
  });

  it("is verified when SES says verified-for-sending, regardless of the enum", () => {
    expect(recipientVerificationState({ verifiedForSending: true })).toBe("verified");
    expect(recipientVerificationState({ verifiedForSending: true, verificationStatus: "PENDING" })).toBe("verified");
    expect(recipientVerificationState({ verifiedForSending: false, verificationStatus: "SUCCESS" })).toBe("verified");
  });

  it("is failed only on a FAILED verification (expired unclicked link)", () => {
    expect(recipientVerificationState({ verifiedForSending: false, verificationStatus: "FAILED" })).toBe("failed");
  });

  it("reads an existing unverified identity as pending (the email went out)", () => {
    expect(recipientVerificationState({ verifiedForSending: false, verificationStatus: "PENDING" })).toBe("pending");
    expect(recipientVerificationState({ verifiedForSending: false, verificationStatus: "TEMPORARY_FAILURE" })).toBe("pending");
    expect(recipientVerificationState({ verifiedForSending: false })).toBe("pending");
  });
});

describe("isUnverifiedRecipientError", () => {
  it("matches the SES sandbox rejection message", () => {
    expect(
      isUnverifiedRecipientError(
        "MessageRejected: Email address is not verified. The following identities failed the check in region EU-WEST-1: you@gmail.com",
      ),
    ).toBe(true);
    expect(isUnverifiedRecipientError("The following identities failed the check in region US-EAST-1: a@b.com")).toBe(true);
    // Singular too: a missed match dead-ends the user on the raw AWS error instead of
    // the verify panel, and the exact wording is AWS's to change, not ours.
    expect(isUnverifiedRecipientError("The following identity failed the check in region eu-west-1: a@b.com")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isUnverifiedRecipientError("Daily message quota exceeded")).toBe(false);
    expect(isUnverifiedRecipientError("AccessDenied: not authorized to perform ses:SendEmail")).toBe(false);
  });
});

// A failed production-access request used to surface as a bare exception name — or
// nothing at all ("unknown error"), which reads as a broken button on a control that
// opens a real AWS support case (field report 2026-08-23).
describe("productionAccessErrorMessage", () => {
  it("explains an authorization failure and where to fix it", () => {
    const msg = productionAccessErrorMessage(
      "AccessDeniedException",
      "User: arn:aws:sts::1:assumed-role/x is not authorized to perform: ses:PutAccountDetails",
    );
    expect(msg).toMatch(/isn't allowed to submit it/);
    expect(msg).toMatch(/AgentsPoppy/);
  });

  it("explains that a request is already open rather than repeating it", () => {
    expect(productionAccessErrorMessage("ConflictException", "Request already submitted")).toMatch(
      /already has a production-access request open/,
    );
  });

  it("passes AWS's own validation complaint through", () => {
    expect(productionAccessErrorMessage("BadRequestException", "WebsiteURL is invalid")).toMatch(/WebsiteURL is invalid/);
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const [n, m] of [["", ""], [undefined, undefined], ["  ", "  "]] as [string?, string?][]) {
      expect(productionAccessErrorMessage(n, m).trim().length).toBeGreaterThan(0);
    }
    expect(productionAccessErrorMessage("", "")).toMatch(/didn't say why/);
  });

  it("keeps an unrecognised AWS message visible, with its type", () => {
    expect(productionAccessErrorMessage("WeirdException", "something odd")).toBe("something odd (WeirdException)");
  });
});
