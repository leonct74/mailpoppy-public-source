import { describe, it, expect } from "vitest";
import { replySubject, forwardSubject, buildReply } from "./reply";
import type { MessageMeta } from "@mailpoppy/core";

function meta(over: Partial<MessageMeta> = {}): MessageMeta {
  return {
    domain: "ollydigital.com",
    mailbox: "me@ollydigital.com",
    messageId: "ses-123",
    threadId: "root-1",
    folder: "inbox",
    from: { name: "Dana", address: "dana@ext.example" },
    to: [{ address: "me@ollydigital.com" }, { address: "team@ollydigital.com" }],
    subject: "Q2 forecast",
    snippet: "numbers look good",
    date: "2026-06-02T10:00:00.000Z",
    flags: { unread: true },
    hasAttachments: false,
    s3Key: "inbound/ses-123",
    sizeBytes: 1024,
    ...over,
  };
}

describe("subject prefixes", () => {
  it("adds Re:/Fwd: once and is idempotent", () => {
    expect(replySubject("Hi")).toBe("Re: Hi");
    expect(replySubject("Re: Hi")).toBe("Re: Hi");
    expect(replySubject("RE: Hi")).toBe("RE: Hi");
    expect(forwardSubject("Hi")).toBe("Fwd: Hi");
    expect(forwardSubject("Fwd: Hi")).toBe("Fwd: Hi");
    expect(forwardSubject("Fw: Hi")).toBe("Fw: Hi");
  });
});

describe("buildReply", () => {
  it("reply → just the sender, Re: subject, threading headers", () => {
    const r = buildReply(meta(), "reply", { self: "me@ollydigital.com" });
    expect(r.to).toEqual(["dana@ext.example"]);
    expect(r.subject).toBe("Re: Q2 forecast");
    expect(r.inReplyTo).toBe("<ses-123>");
    expect(r.references).toBe("<root-1> <ses-123>");
    expect(r.text).toContain("> numbers look good");
  });

  it("reply-all → sender + other recipients, excluding self, de-duplicated", () => {
    const r = buildReply(meta(), "replyAll", { self: "me@ollydigital.com" });
    expect(r.to).toEqual(["dana@ext.example", "team@ollydigital.com"]);
    expect(r.to).not.toContain("me@ollydigital.com");
  });

  it("collapses References to just the message when it is its own thread root", () => {
    const r = buildReply(meta({ threadId: "ses-123" }), "reply", { self: "me@ollydigital.com" });
    expect(r.references).toBe("<ses-123>");
  });

  it("forward → no recipients, Fwd: subject, forwarded header, no In-Reply-To", () => {
    const r = buildReply(meta(), "forward", { self: "me@ollydigital.com", quotedBody: "full body" });
    expect(r.to).toEqual([]);
    expect(r.subject).toBe("Fwd: Q2 forecast");
    expect(r.inReplyTo).toBeUndefined();
    expect(r.text).toContain("Forwarded message");
    expect(r.text).toContain("full body");
  });
});
