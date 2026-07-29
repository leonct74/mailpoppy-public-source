import { describe, it, expect } from "vitest";
import {
  mapImapFolder,
  sanitizeFolderName,
  imapFlagsToFlags,
  isImapDeleted,
} from "./migration";

describe("mapImapFolder", () => {
  it("prefers the IMAP special-use attribute", () => {
    expect(mapImapFolder("Verstuurd", "\\Sent")).toBe("sent");
    expect(mapImapFolder("Papierkorb", "\\Trash")).toBe("trash");
    expect(mapImapFolder("Whatever", "\\Drafts")).toBe("drafts");
    expect(mapImapFolder("Gmail/All Mail", "\\All")).toBe("archive");
  });

  it("falls back to name heuristics (WorkMail / Outlook / Gmail names)", () => {
    expect(mapImapFolder("INBOX")).toBe("inbox");
    expect(mapImapFolder("Sent Items")).toBe("sent");
    expect(mapImapFolder("Sent Messages")).toBe("sent");
    expect(mapImapFolder("Drafts")).toBe("drafts");
    expect(mapImapFolder("Deleted Items")).toBe("trash");
    expect(mapImapFolder("Junk E-mail")).toBe("junk");
    expect(mapImapFolder("Archive")).toBe("archive");
  });

  it("handles a hierarchical INBOX child by its leaf name", () => {
    expect(mapImapFolder("INBOX.Sent", "")).toBe("sent");
    expect(mapImapFolder("INBOX/Drafts")).toBe("drafts");
  });

  it("preserves unknown folders as a sanitized custom folder (lossless)", () => {
    expect(mapImapFolder("Projects")).toBe("projects");
    expect(mapImapFolder("INBOX/Clients/ACME Corp")).toBe("acme-corp");
  });

  it("never lets '#' into a folder token (would corrupt the sort key)", () => {
    expect(mapImapFolder("a#b#c")).not.toContain("#");
    expect(sanitizeFolderName("Team #1 / Notes")).toBe("team-1-notes");
  });

  it("sanitizeFolderName degrades gracefully to 'folder'", () => {
    expect(sanitizeFolderName("###")).toBe("folder");
    expect(sanitizeFolderName("")).toBe("folder");
  });
});

describe("imapFlagsToFlags", () => {
  it("maps \\Seen to read and omits optional flags when absent", () => {
    expect(imapFlagsToFlags(["\\Seen"])).toEqual({ unread: false });
    expect(imapFlagsToFlags([])).toEqual({ unread: true });
  });

  it("maps \\Flagged → starred and \\Answered → answered", () => {
    expect(imapFlagsToFlags(["\\Seen", "\\Flagged", "\\Answered"])).toEqual({
      unread: false,
      starred: true,
      answered: true,
    });
  });

  it("is case-insensitive about flag spelling", () => {
    expect(imapFlagsToFlags(["\\seen", "\\FLAGGED"])).toEqual({ unread: false, starred: true });
  });
});

describe("isImapDeleted", () => {
  it("detects the \\Deleted flag", () => {
    expect(isImapDeleted(["\\Seen", "\\Deleted"])).toBe(true);
    expect(isImapDeleted(["\\Seen"])).toBe(false);
  });
});
