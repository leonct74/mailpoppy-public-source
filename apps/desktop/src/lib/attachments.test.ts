import { describe, it, expect } from "vitest";
import { fileToAttachment } from "./attachments";

describe("fileToAttachment", () => {
  it("reads a file into filename/contentType/base64", async () => {
    const file = new File(["hello attachment"], "note.txt", { type: "text/plain" });
    const att = await fileToAttachment(file);
    expect(att.filename).toBe("note.txt");
    expect(att.contentType).toBe("text/plain");
    expect(atob(att.contentBase64)).toBe("hello attachment");
  });

  it("falls back to a generic content type when none is given", async () => {
    const file = new File(["x"], "blob.bin");
    const att = await fileToAttachment(file);
    expect(att.contentType).toBe("application/octet-stream");
  });
});
