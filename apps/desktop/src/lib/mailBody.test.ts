// Sanitizer tests run in jsdom (DOMPurify needs a DOM). The postal-mime parser
// tests live in mailBody.parse.test.ts (node env) — postal-mime targets real
// browser/worker engines and node, but misbehaves under jsdom specifically.
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./mailBody";

describe("sanitizeHtml", () => {
  it("strips <script> and event handlers", () => {
    const { clean } = sanitizeHtml(
      `<p onclick="steal()">hi</p><script>evil()</script>`,
      { allowRemoteImages: true },
    );
    expect(clean).toContain("hi");
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onclick");
  });

  it("neutralizes javascript: links and hardens anchors", () => {
    const { clean } = sanitizeHtml(`<a href="javascript:alert(1)">x</a>`, { allowRemoteImages: true });
    expect(clean).not.toContain("javascript:");
    const { clean: safe } = sanitizeHtml(`<a href="https://example.com">x</a>`, { allowRemoteImages: true });
    expect(safe).toContain('target="_blank"');
    expect(safe).toContain("noopener");
  });

  it("blocks remote images by default and reports it", () => {
    const { clean, blockedRemote } = sanitizeHtml(
      `<img src="https://tracker.example/pixel.gif"><p>body</p>`,
      { allowRemoteImages: false },
    );
    expect(blockedRemote).toBe(true);
    expect(clean).not.toContain("tracker.example");
    expect(clean).toContain("body");
  });

  it("keeps remote images when explicitly allowed", () => {
    const { clean, blockedRemote } = sanitizeHtml(
      `<img src="https://cdn.example/logo.png">`,
      { allowRemoteImages: true },
    );
    expect(blockedRemote).toBe(false);
    expect(clean).toContain("cdn.example/logo.png");
  });

  it("strips url(...) from inline styles when blocking remote content", () => {
    const { clean, blockedRemote } = sanitizeHtml(
      `<div style="background:url(https://tracker.example/bg.png)">x</div>`,
      { allowRemoteImages: false },
    );
    expect(blockedRemote).toBe(true);
    expect(clean).not.toContain("tracker.example");
  });
});
