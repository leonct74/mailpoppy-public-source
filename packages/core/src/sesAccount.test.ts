import { describe, it, expect } from "vitest";
import {
  sendingAccessState,
  isSandboxed,
  validateProductionAccessRequest,
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
