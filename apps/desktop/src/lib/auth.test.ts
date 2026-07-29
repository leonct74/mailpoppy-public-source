import { describe, it, expect } from "vitest";
import { emailFromJwt } from "./auth";

// Build a JWT-shaped string (header.payload.signature) with a base64url payload —
// we only ever decode the payload, so the header/signature are placeholders.
function jwt(payload: object): string {
  const b64url = (o: object) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.sig`;
}

describe("emailFromJwt", () => {
  it("returns the email claim, not the opaque username/sub", () => {
    const token = jwt({ sub: "f285b484-6091-70b0-920e", "cognito:username": "f285b484-6091-70b0-920e", email: "you@ollydigital.com" });
    expect(emailFromJwt(token)).toBe("you@ollydigital.com");
  });

  it("returns null when there's no email claim (so we never show the UUID)", () => {
    expect(emailFromJwt(jwt({ sub: "f285b484-6091-70b0-920e" }))).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(emailFromJwt("not-a-jwt")).toBeNull();
    expect(emailFromJwt("")).toBeNull();
  });
});
