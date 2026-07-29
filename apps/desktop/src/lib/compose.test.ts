import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./compose";

describe("renderMarkdown", () => {
  it("renders basic Markdown formatting", () => {
    expect(renderMarkdown("**bold** and *italic*")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("**bold** and *italic*")).toContain("<em>italic</em>");
  });

  it("renders links and hardens them (sanitizer adds target/rel)", () => {
    const html = renderMarkdown("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
  });

  it("renders blockquotes (used by reply quoting) and lists", () => {
    expect(renderMarkdown("> quoted line")).toContain("<blockquote>");
    expect(renderMarkdown("- a\n- b")).toContain("<li>");
  });

  it("strips dangerous HTML pasted into the body", () => {
    const html = renderMarkdown(`hello <script>steal()</script><img src=x onerror=evil()>`);
    expect(html).toContain("hello");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
