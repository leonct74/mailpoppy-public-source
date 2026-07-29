// @vitest-environment node
// postal-mime targets real browser/worker engines and node; it misbehaves under
// jsdom specifically, so the parser is exercised in the node environment here
// (the desktop runs in a WebKit webview, not jsdom). The sanitizer — which needs
// a DOM — is tested separately in mailBody.test.ts (jsdom).
import { describe, it, expect } from "vitest";
import { parseBody } from "./mailBody";

describe("parseBody", () => {
  it("extracts the HTML part of a MIME message", async () => {
    const eml = [
      "From: a@b.com",
      "To: c@d.com",
      "Subject: Hello",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello <b>world</b></p>",
    ].join("\r\n");
    const body = await parseBody(eml);
    expect(body.html).toContain("Hello");
    expect(body.subject).toBe("Hello");
  });

  it("extracts plain text when there is no HTML part", async () => {
    const eml = ["From: a@b.com", "Subject: Plain", "", "just text here"].join("\r\n");
    const body = await parseBody(eml);
    expect(body.text).toContain("just text here");
  });
});
