import { describe, it, expect } from "vitest";
import {
  devicesSettingsKey,
  isExpoPushToken,
  addDeviceToken,
  removeDeviceToken,
  removeDeviceTokens,
  pruneDeviceTokens,
  buildExpoPushMessages,
  MAX_DEVICE_TOKENS,
  DEVICE_TOKEN_TTL_DAYS,
  type DeviceRegistry,
} from "./push";

const TOK = (n: number) => `ExponentPushToken[token-${n}]`;

describe("devicesSettingsKey", () => {
  it("namespaces + lowercases the mailbox address", () => {
    expect(devicesSettingsKey("  Marco@Olly.com ")).toBe("devices#marco@olly.com");
  });
});

describe("isExpoPushToken", () => {
  it("accepts current and legacy Expo token envelopes", () => {
    expect(isExpoPushToken("ExponentPushToken[abc123]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abc123]")).toBe(true);
  });
  it("rejects junk, raw device tokens and non-strings", () => {
    expect(isExpoPushToken("abc123")).toBe(false);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("ExponentPushToken[has space]")).toBe(false);
    expect(isExpoPushToken(undefined)).toBe(false);
    expect(isExpoPushToken(42)).toBe(false);
  });
});

describe("addDeviceToken", () => {
  it("adds a new token with an ISO timestamp", () => {
    const now = Date.parse("2026-06-12T10:00:00Z");
    const reg = addDeviceToken(null, TOK(1), "ios", now);
    expect(reg.tokens).toHaveLength(1);
    expect(reg.tokens[0]).toEqual({
      token: TOK(1),
      platform: "ios",
      updatedAt: "2026-06-12T10:00:00.000Z",
    });
  });

  it("refreshes (dedupes) an existing token, moving it to the front", () => {
    const t0 = Date.parse("2026-06-01T00:00:00Z");
    let reg = addDeviceToken(null, TOK(1), "ios", t0);
    reg = addDeviceToken(reg, TOK(2), "android", t0 + 1000);
    // Re-register TOK(1) later → it should move to front and update platform.
    reg = addDeviceToken(reg, TOK(1), "android", t0 + 5000);
    expect(reg.tokens).toHaveLength(2);
    expect(reg.tokens[0]).toMatchObject({ token: TOK(1), platform: "android" });
  });

  it("ignores an invalid token but still prunes", () => {
    const reg = addDeviceToken({ tokens: [] }, "not-a-token", "ios");
    expect(reg.tokens).toHaveLength(0);
  });

  it("caps the registry at MAX_DEVICE_TOKENS, keeping the most recent", () => {
    let reg: DeviceRegistry = { tokens: [] };
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < MAX_DEVICE_TOKENS + 5; i++) {
      reg = addDeviceToken(reg, TOK(i), "ios", base + i * 1000);
    }
    expect(reg.tokens).toHaveLength(MAX_DEVICE_TOKENS);
    // The newest (highest i) is kept; the oldest five are dropped.
    expect(reg.tokens[0]?.token).toBe(TOK(MAX_DEVICE_TOKENS + 4));
    expect(reg.tokens.map((t) => t.token)).not.toContain(TOK(0));
  });
});

describe("pruneDeviceTokens", () => {
  it("drops tokens older than the TTL", () => {
    const now = Date.parse("2026-06-12T00:00:00Z");
    const old = new Date(now - (DEVICE_TOKEN_TTL_DAYS + 1) * 86_400_000).toISOString();
    const fresh = new Date(now - 1000).toISOString();
    const reg = pruneDeviceTokens(
      { tokens: [
        { token: TOK(1), platform: "ios", updatedAt: old },
        { token: TOK(2), platform: "ios", updatedAt: fresh },
      ] },
      now,
    );
    expect(reg.tokens.map((t) => t.token)).toEqual([TOK(2)]);
  });

  it("discards malformed token entries", () => {
    const reg = pruneDeviceTokens({
      tokens: [{ token: "garbage", platform: "ios", updatedAt: new Date().toISOString() }],
    });
    expect(reg.tokens).toHaveLength(0);
  });
});

describe("removeDeviceToken(s)", () => {
  it("removes one token", () => {
    let reg = addDeviceToken(null, TOK(1), "ios");
    reg = addDeviceToken(reg, TOK(2), "ios");
    reg = removeDeviceToken(reg, TOK(1));
    expect(reg.tokens.map((t) => t.token)).toEqual([TOK(2)]);
  });
  it("removes a batch of tokens", () => {
    let reg = addDeviceToken(null, TOK(1), "ios");
    reg = addDeviceToken(reg, TOK(2), "ios");
    reg = addDeviceToken(reg, TOK(3), "ios");
    reg = removeDeviceTokens(reg, [TOK(1), TOK(3)]);
    expect(reg.tokens.map((t) => t.token)).toEqual([TOK(2)]);
  });
});

describe("buildExpoPushMessages", () => {
  it("builds one message per valid token with sender title + subject body", () => {
    const msgs = buildExpoPushMessages([TOK(1), TOK(2)], {
      title: "Marco Rossi",
      body: "Invoice for June",
      data: { messageId: "m1", folder: "inbox" },
    });
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      to: TOK(1),
      title: "Marco Rossi",
      body: "Invoice for June",
      sound: "default",
      priority: "high",
      data: { messageId: "m1", folder: "inbox" },
    });
  });

  it("skips invalid + duplicate tokens", () => {
    const msgs = buildExpoPushMessages([TOK(1), "junk", TOK(1)], { title: "x" });
    expect(msgs.map((m) => m.to)).toEqual([TOK(1)]);
  });

  it("accepts DeviceToken objects and clamps overlong fields", () => {
    const longSubject = "x".repeat(500);
    const msgs = buildExpoPushMessages(
      [{ token: TOK(1), platform: "ios", updatedAt: new Date().toISOString() }],
      { body: longSubject },
    );
    expect(msgs[0]?.body?.length).toBeLessThanOrEqual(240);
    expect(msgs[0]?.body?.endsWith("…")).toBe(true);
  });
});
