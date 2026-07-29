import { describe, it, expect } from "vitest";
import {
  rate,
  bounceHealth,
  complaintHealth,
  overallHealth,
  hasSendHistory,
  domainHealth,
  type DeliverabilityStatus,
  type DomainDeliverability,
} from "./deliverability";

function status(p: Partial<DeliverabilityStatus> = {}): DeliverabilityStatus {
  return {
    totals: { deliveryAttempts: 100, bounces: 0, complaints: 0, rejects: 0 },
    bounceRate: 0,
    complaintRate: 0,
    windowDays: 14,
    sendingPaused: false,
    dailyUsed: 0,
    dailyLimit: 50000,
    suppressed: [],
    ...p,
  };
}

describe("rate", () => {
  it("divides safely and returns 0 with no history", () => {
    expect(rate(5, 100)).toBe(0.05);
    expect(rate(0, 0)).toBe(0); // fresh account — no NaN
    expect(rate(3, 0)).toBe(0);
  });
});

describe("bounceHealth", () => {
  it("is good below 2%", () => {
    expect(bounceHealth(0)).toBe("good");
    expect(bounceHealth(0.019)).toBe("good");
  });
  it("warns from 2% up to 5%", () => {
    expect(bounceHealth(0.02)).toBe("watch");
    expect(bounceHealth(0.049)).toBe("watch");
  });
  it("flags at 5% and above (AWS review point)", () => {
    expect(bounceHealth(0.05)).toBe("action");
    expect(bounceHealth(0.2)).toBe("action");
  });
});

describe("complaintHealth", () => {
  it("is good below 0.1%", () => {
    expect(complaintHealth(0)).toBe("good");
    expect(complaintHealth(0.0009)).toBe("good");
  });
  it("warns from 0.1% up to 0.5%", () => {
    expect(complaintHealth(0.001)).toBe("watch");
    expect(complaintHealth(0.0049)).toBe("watch");
  });
  it("flags at 0.5% and above", () => {
    expect(complaintHealth(0.005)).toBe("action");
    expect(complaintHealth(0.02)).toBe("action");
  });
});

describe("overallHealth", () => {
  it("is good when both rates are healthy", () => {
    expect(overallHealth(status())).toBe("good");
  });
  it("takes the worst of bounce and complaint", () => {
    expect(overallHealth(status({ bounceRate: 0.03 }))).toBe("watch");
    expect(overallHealth(status({ complaintRate: 0.006 }))).toBe("action");
    expect(overallHealth(status({ bounceRate: 0.03, complaintRate: 0.006 }))).toBe("action");
  });
  it("is always action when sending is paused, regardless of rates", () => {
    expect(overallHealth(status({ sendingPaused: true }))).toBe("action");
  });
  it("treats no data as good (nothing wrong yet)", () => {
    expect(overallHealth(null)).toBe("good");
    expect(overallHealth(undefined)).toBe("good");
  });
});

describe("hasSendHistory", () => {
  it("is false until something has been sent", () => {
    expect(hasSendHistory(status({ totals: { deliveryAttempts: 0, bounces: 0, complaints: 0, rejects: 0 } }))).toBe(
      false,
    );
    expect(hasSendHistory(null)).toBe(false);
    expect(hasSendHistory(status())).toBe(true);
  });
});

describe("domainHealth", () => {
  const dom = (p: Partial<DomainDeliverability> = {}): DomainDeliverability => ({
    domain: "x.com",
    sends: 100,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    suppressedCount: 0,
    windowDays: 14,
    ...p,
  });
  it("is good for a clean domain", () => {
    expect(domainHealth(dom())).toBe("good");
  });
  it("takes the worst of the two rates", () => {
    expect(domainHealth(dom({ bounceRate: 0.03 }))).toBe("watch");
    expect(domainHealth(dom({ complaintRate: 0.01 }))).toBe("action");
    expect(domainHealth(dom({ bounceRate: 0.03, complaintRate: 0.01 }))).toBe("action");
  });
});
