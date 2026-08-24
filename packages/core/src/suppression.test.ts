import { describe, it, expect } from "vitest";
import {
  suppressionKey,
  addressFromSuppressionKey,
  splitSuppressedRecipients,
  suppressedRecipientsMessage,
} from "./suppression";

describe("suppressionKey", () => {
  it("normalises the address so one person can't occupy two rows", () => {
    expect(suppressionKey("  Bob@Example.COM ")).toBe("SUPPRESS#bob@example.com");
  });

  it("round-trips with addressFromSuppressionKey", () => {
    expect(addressFromSuppressionKey(suppressionKey("bob@example.com"))).toBe("bob@example.com");
    expect(addressFromSuppressionKey("quota#a@b.com")).toBe("");
  });
});

describe("splitSuppressedRecipients", () => {
  const list = [
    { address: "gone@example.com", reason: "bounce", detail: "Permanent" },
    { address: "angry@example.com", reason: "complaint" },
  ];

  it("lets clean recipients through and holds back suppressed ones", () => {
    const { allowed, blocked } = splitSuppressedRecipients(["ok@example.com", "gone@example.com"], list);
    expect(allowed).toEqual(["ok@example.com"]);
    expect(blocked.map((b) => b.address)).toEqual(["gone@example.com"]);
  });

  it("matches regardless of case or padding — the sender types it freehand", () => {
    const { allowed, blocked } = splitSuppressedRecipients(["  ANGRY@Example.com "], list);
    expect(allowed).toEqual([]);
    expect(blocked.map((b) => b.address)).toEqual(["angry@example.com"]);
  });

  it("reports a duplicated recipient once (same address in To and Cc)", () => {
    const { blocked } = splitSuppressedRecipients(["gone@example.com", "GONE@example.com"], list);
    expect(blocked).toHaveLength(1);
  });

  it("is a no-op when nothing is suppressed", () => {
    const { allowed, blocked } = splitSuppressedRecipients(["a@b.com", "c@d.com"], []);
    expect(allowed).toEqual(["a@b.com", "c@d.com"]);
    expect(blocked).toEqual([]);
  });

  it("ignores blank entries on either side rather than blocking everything", () => {
    const { allowed, blocked } = splitSuppressedRecipients(["a@b.com", ""], [{ address: "" }, { address: "  " }]);
    expect(allowed).toEqual(["a@b.com"]);
    expect(blocked).toEqual([]);
  });
});

describe("suppressedRecipientsMessage", () => {
  it("names every address, says why in plain words, and says how to undo it", () => {
    const msg = suppressedRecipientsMessage([
      { address: "gone@example.com", reason: "bounce" },
      { address: "angry@example.com", reason: "complaint" },
    ]);
    expect(msg).toContain("gone@example.com");
    expect(msg).toContain("kept bouncing");
    expect(msg).toContain("angry@example.com");
    expect(msg).toContain("marked a previous message as spam");
    expect(msg).toMatch(/administrator can clear it under Sending health/i);
    // The point of blocking rather than letting AWS drop it silently.
    expect(msg).toMatch(/silently/i);
  });

  it("reads correctly for a single address", () => {
    expect(suppressedRecipientsMessage([{ address: "a@b.com" }])).toContain("this address");
  });
});
