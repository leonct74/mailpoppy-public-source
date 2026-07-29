import { describe, it, expect } from "vitest";
import { upsertIniSection } from "./ini";

const creds = (k: string, s: string) => [`aws_access_key_id = ${k}`, `aws_secret_access_key = ${s}`];

describe("upsertIniSection", () => {
  it("creates the section in an empty file", () => {
    expect(upsertIniSection("", "mailpoppy", creds("AKIA1", "sec1"))).toBe(
      "[mailpoppy]\naws_access_key_id = AKIA1\naws_secret_access_key = sec1\n",
    );
  });

  it("appends without touching an existing profile", () => {
    const existing = "[default]\naws_access_key_id = OLD\naws_secret_access_key = OLDSEC\n";
    const out = upsertIniSection(existing, "mailpoppy", creds("AKIA2", "sec2"));
    expect(out).toContain("[default]\naws_access_key_id = OLD\naws_secret_access_key = OLDSEC");
    expect(out).toContain("[mailpoppy]\naws_access_key_id = AKIA2\naws_secret_access_key = sec2");
    // default profile is preserved verbatim, exactly one blank line between sections
    expect(out).toBe(
      "[default]\naws_access_key_id = OLD\naws_secret_access_key = OLDSEC\n\n" +
        "[mailpoppy]\naws_access_key_id = AKIA2\naws_secret_access_key = sec2\n",
    );
  });

  it("replaces an existing section's body, not duplicating it", () => {
    const existing =
      "[mailpoppy]\naws_access_key_id = OLD\naws_secret_access_key = OLDSEC\n\n[default]\nregion = x\n";
    const out = upsertIniSection(existing, "mailpoppy", creds("NEW", "NEWSEC"));
    // only one mailpoppy header
    expect(out.match(/\[mailpoppy\]/g)).toHaveLength(1);
    expect(out).toContain("aws_access_key_id = NEW");
    expect(out).not.toContain("OLD");
    // the trailing [default] section is preserved
    expect(out).toContain("[default]\nregion = x");
  });

  it("replaces a section that sits at end of file", () => {
    const existing = "[default]\nregion = x\n\n[mailpoppy]\naws_access_key_id = OLD\naws_secret_access_key = OLDSEC\n";
    const out = upsertIniSection(existing, "mailpoppy", creds("NEW", "NEWSEC"));
    expect(out).toBe("[default]\nregion = x\n\n[mailpoppy]\naws_access_key_id = NEW\naws_secret_access_key = NEWSEC\n");
  });

  it("includes an optional session token line when provided", () => {
    const out = upsertIniSection("", "mailpoppy", [...creds("ASIA", "sec"), "aws_session_token = TOK"]);
    expect(out).toContain("aws_session_token = TOK");
  });

  it("normalises CRLF and always ends with exactly one trailing newline", () => {
    const out = upsertIniSection("[default]\r\nk = v\r\n", "mailpoppy", creds("A", "B"));
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
    expect(out).not.toContain("\r");
  });
});
