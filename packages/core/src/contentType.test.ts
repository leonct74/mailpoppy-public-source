import { describe, it, expect } from "vitest";
import { guessContentType, resolveContentType, DEFAULT_CONTENT_TYPE } from "./contentType";

describe("guessContentType", () => {
  it("maps common image extensions (case-insensitive)", () => {
    expect(guessContentType("photo.png")).toBe("image/png");
    expect(guessContentType("PHOTO.PNG")).toBe("image/png");
    expect(guessContentType("scan.JPG")).toBe("image/jpeg");
    expect(guessContentType("a.jpeg")).toBe("image/jpeg");
    expect(guessContentType("logo.svg")).toBe("image/svg+xml");
    expect(guessContentType("pic.heic")).toBe("image/heic");
  });

  it("maps documents and archives", () => {
    expect(guessContentType("report.pdf")).toBe("application/pdf");
    expect(guessContentType("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(guessContentType("notes.txt")).toBe("text/plain");
    expect(guessContentType("data.csv")).toBe("text/csv");
    expect(guessContentType("bundle.zip")).toBe("application/zip");
  });

  it("falls back to octet-stream for unknown/missing extensions", () => {
    expect(guessContentType("mystery.xyz")).toBe(DEFAULT_CONTENT_TYPE);
    expect(guessContentType("noext")).toBe(DEFAULT_CONTENT_TYPE);
    expect(guessContentType("trailingdot.")).toBe(DEFAULT_CONTENT_TYPE);
    expect(guessContentType("")).toBe(DEFAULT_CONTENT_TYPE);
    expect(guessContentType(undefined)).toBe(DEFAULT_CONTENT_TYPE);
  });

  it("handles dotfiles and multi-dot names by the last extension", () => {
    expect(guessContentType("archive.tar.gz")).toBe("application/gzip");
    expect(guessContentType(".gitignore")).toBe(DEFAULT_CONTENT_TYPE); // ext "gitignore" unknown
  });
});

describe("resolveContentType", () => {
  it("trusts a specific declared type", () => {
    expect(resolveContentType("image/png", "x.bin")).toBe("image/png");
  });

  it("infers from filename when declared type is missing or generic", () => {
    expect(resolveContentType("", "photo.png")).toBe("image/png");
    expect(resolveContentType(undefined, "photo.jpg")).toBe("image/jpeg");
    // The Tauri webview picker handing us octet-stream is the real-world bug.
    expect(resolveContentType(DEFAULT_CONTENT_TYPE, "photo.png")).toBe("image/png");
  });

  it("keeps octet-stream when nothing better is known", () => {
    expect(resolveContentType(DEFAULT_CONTENT_TYPE, "mystery.xyz")).toBe(DEFAULT_CONTENT_TYPE);
    expect(resolveContentType("", "noext")).toBe(DEFAULT_CONTENT_TYPE);
  });
});
