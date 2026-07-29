import { describe, it, expect } from "vitest";
import {
  agentOwnedSettingsKey,
  agentMailText,
  htmlToAgentText,
  buildAgentMailPayload,
  AGENT_TEXT_MAX_CHARS,
  CREWPOPPY_RUNNER_FUNCTION,
} from "./agentBridge";

describe("agentOwnedSettingsKey", () => {
  it("normalizes the address", () => {
    expect(agentOwnedSettingsKey("  Postie@Olly.COM ")).toBe("agent#postie@olly.com");
  });
});

describe("agentMailText", () => {
  it("prefers the plain-text part over HTML", () => {
    expect(agentMailText("hello there", "<p>ignored</p>")).toBe("hello there");
  });

  it("converts HTML when there is no text part", () => {
    const html = "<style>p{color:red}</style><p>Make me an &amp; offer<br>for &lt;XYZ&gt;</p><script>x()</script>";
    expect(agentMailText(undefined, html)).toBe("Make me an & offer\nfor <XYZ>");
  });

  it("truncates at the 20 000-char cap", () => {
    const long = "a".repeat(AGENT_TEXT_MAX_CHARS + 500);
    expect(agentMailText(long, undefined)).toHaveLength(AGENT_TEXT_MAX_CHARS);
  });

  it("is empty when there is no body at all", () => {
    expect(agentMailText(undefined, undefined)).toBe("");
    expect(agentMailText("  ", "")).toBe("");
  });
});

describe("htmlToAgentText", () => {
  it("keeps paragraph structure as newlines", () => {
    expect(htmlToAgentText("<div>one</div><div>two</div>")).toBe("one\ntwo");
  });
});

describe("buildAgentMailPayload", () => {
  const base = {
    to: "Postie@Olly.com",
    from: "Owner@Olly.com",
    subject: "Offer for XYZ",
    text: "Please make an offer",
    messageId: "ses-msg-1",
    receivedAt: "2026-07-28T18:00:00Z",
    verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS" } as const,
  };

  it("matches the v1 wire contract exactly — no extra fields, no attachments", () => {
    const p = buildAgentMailPayload(base);
    expect(p).toEqual({
      kind: "mail",
      to: "postie@olly.com",
      from: "owner@olly.com",
      subject: "Offer for XYZ",
      text: "Please make an offer",
      messageId: "ses-msg-1",
      receivedAt: "2026-07-28T18:00:00Z",
      verdicts: { spf: "PASS", dkim: "PASS", spam: "PASS", virus: "PASS" },
    });
    // The contract has exactly these keys — a new field is a breaking change for
    // CrewPoppy's receiving half, so lock the shape down.
    expect(Object.keys(p).sort()).toEqual(
      ["from", "kind", "messageId", "receivedAt", "subject", "text", "to", "verdicts"].sort(),
    );
    expect(Object.keys(p.verdicts).sort()).toEqual(["dkim", "spam", "spf", "virus"]);
  });

  it("passes verdicts through uppercased and maps absent ones to GRAY, never PASS", () => {
    const p = buildAgentMailPayload({
      ...base,
      verdicts: { spam: "PASS", virus: "PASS" }, // spf/dkim not evaluated
    });
    expect(p.verdicts).toEqual({ spf: "GRAY", dkim: "GRAY", spam: "PASS", virus: "PASS" });
  });

  it("names the fixed runner function", () => {
    expect(CREWPOPPY_RUNNER_FUNCTION).toBe("CrewPoppyRunner");
  });
});
