import { describe, it, expect } from "vitest";
import { validateTestRecipient } from "./deliverability";

describe("validateTestRecipient", () => {
  const domain = "yourdomain.com";

  it("accepts a valid external inbox", () => {
    expect(validateTestRecipient("you@gmail.com", domain)).toBeNull();
    expect(validateTestRecipient("first.last@outlook.com", domain)).toBeNull();
  });

  it("rejects a malformed address", () => {
    expect(validateTestRecipient("not-an-email", domain)).toMatch(/valid email/i);
    expect(validateTestRecipient("missing@tld", domain)).toMatch(/valid email/i);
    expect(validateTestRecipient("", domain)).toMatch(/valid email/i);
  });

  it("rejects an address on the domain being set up (the user's mistake)", () => {
    const err = validateTestRecipient("support@yourdomain.com", domain);
    expect(err).toMatch(/not an address on yourdomain\.com/i);
  });

  it("matches the own-domain case-insensitively and after trimming", () => {
    expect(validateTestRecipient("  Support@YourDomain.COM  ", "yourdomain.com")).toMatch(/not an address on/i);
    expect(validateTestRecipient("you@gmail.com", "  YourDomain.com ")).toBeNull();
  });

  it("does not false-match a subdomain or a look-alike domain", () => {
    expect(validateTestRecipient("you@mail.yourdomain.com", domain)).toBeNull();
    expect(validateTestRecipient("you@yourdomain.com.evil.com", domain)).toBeNull();
  });
});
