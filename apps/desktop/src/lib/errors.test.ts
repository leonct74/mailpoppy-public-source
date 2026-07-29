import { describe, it, expect } from "vitest";
import { friendlyError } from "./errors";

describe("friendlyError", () => {
  it("extracts the inner .error from a JSON sidecar envelope (e.g. a 502)", () => {
    const e = new Error('sidecar 502: {"ok":false,"error":"Stack delete failed: bucket not empty"}');
    expect(friendlyError(e)).toBe("Stack delete failed: bucket not empty");
  });

  it("prefers .message over the err-name .error (the global handler's envelope)", () => {
    // The sidecar's setErrorHandler returns {error: <err.name>, message: <human text>}.
    // Reading .error would surface a useless bare "Error" — .message is the real reason.
    const e = new Error(
      'sidecar 500: {"ok":false,"code":"NoZone","error":"Error","message":"No Route53 hosted zone found for nozone.com"}',
    );
    expect(friendlyError(e)).toBe("No Route53 hosted zone found for nozone.com");
  });

  it("surfaces a plain-text sidecar body without the status prefix", () => {
    const e = new Error("sidecar 404: No deployed MailPoppy backend was found yet.");
    expect(friendlyError(e)).toBe("No deployed MailPoppy backend was found yet.");
  });

  it("falls back to a generic phrase for an empty-bodied status", () => {
    expect(friendlyError(new Error("sidecar 403: "))).toBe("You don't have permission to do that.");
  });

  it("passes already-friendly messages through unchanged (network/helper failures)", () => {
    const msg = "Couldn't reach AWS — please check your internet connection and try again.";
    expect(friendlyError(new Error(msg))).toBe(msg);
  });

  it("handles non-Error values and empties with the fallback", () => {
    expect(friendlyError(null)).toMatch(/something went wrong/i);
    expect(friendlyError("boom")).toBe("boom");
  });
});
