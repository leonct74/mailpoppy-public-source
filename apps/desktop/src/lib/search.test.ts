import { describe, it, expect } from "vitest";
import { messageMatches, filterMessages } from "./search";
import type { MessageMeta } from "@mailpoppy/core";

function msg(over: Partial<MessageMeta> = {}): MessageMeta {
  return {
    domain: "ollydigital.com",
    mailbox: "me@ollydigital.com",
    messageId: "m1",
    threadId: "m1",
    folder: "inbox",
    from: { name: "Dana Vandenberg", address: "dana@partner.example" },
    to: [{ address: "me@ollydigital.com" }],
    subject: "Q2 forecast review",
    snippet: "numbers look good for the quarter",
    date: "2026-06-02T10:00:00.000Z",
    flags: { unread: true },
    hasAttachments: false,
    s3Key: "inbound/m1",
    sizeBytes: 1024,
    ...over,
  };
}

describe("messageMatches", () => {
  it("matches against subject, sender name/address, and snippet", () => {
    expect(messageMatches(msg(), "forecast")).toBe(true);
    expect(messageMatches(msg(), "vandenberg")).toBe(true);
    expect(messageMatches(msg(), "partner.example")).toBe(true);
    expect(messageMatches(msg(), "quarter")).toBe(true);
  });
  it("is case-insensitive and ANDs multiple tokens", () => {
    expect(messageMatches(msg(), "Q2 GOOD")).toBe(true);
    expect(messageMatches(msg(), "forecast missing")).toBe(false);
  });
  it("empty query matches everything", () => {
    expect(messageMatches(msg(), "   ")).toBe(true);
  });
});

describe("filterMessages", () => {
  it("returns the original list for an empty query, filters otherwise", () => {
    const items = [msg({ messageId: "a", subject: "invoice" }), msg({ messageId: "b", subject: "lunch" })];
    expect(filterMessages(items, "")).toHaveLength(2);
    expect(filterMessages(items, "invoice").map((m) => m.messageId)).toEqual(["a"]);
    expect(filterMessages(items, "dinner")).toHaveLength(0);
  });
});
