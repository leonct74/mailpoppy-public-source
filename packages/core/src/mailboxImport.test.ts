import { describe, it, expect } from "vitest";
import {
  planMailboxImport,
  planFromGrid,
  detectHeaderRow,
  normalizeHeader,
  parseImapSecurity,
  rowsFromGrid,
  type RawImportRow,
} from "./mailboxImport";

const DOMAIN = "acme.com";

describe("normalizeHeader", () => {
  it("lowercases, strips parentheticals and collapses separators", () => {
    expect(normalizeHeader("IMAP Host (optional)")).toBe("imap_host");
    expect(normalizeHeader("  Email-Address ")).toBe("email_address");
    expect(normalizeHeader("imap__port")).toBe("imap_port");
  });
});

describe("parseImapSecurity", () => {
  it("maps SSL/TLS-ish values to secure, STARTTLS/plain to insecure, blank to undefined", () => {
    expect(parseImapSecurity("SSL")).toBe(true);
    expect(parseImapSecurity("ssl/tls")).toBe(true);
    expect(parseImapSecurity("993")).toBe(true);
    expect(parseImapSecurity("STARTTLS")).toBe(false);
    expect(parseImapSecurity("none")).toBe(false);
    expect(parseImapSecurity("143")).toBe(false);
    expect(parseImapSecurity("")).toBeUndefined();
  });
});

describe("planMailboxImport", () => {
  it("accepts a bare local part and appends the domain", () => {
    const plan = planMailboxImport([{ email: "sales", password: "Hunter2!xY" }], { domain: DOMAIN });
    expect(plan.rows[0].email).toBe("sales@acme.com");
    expect(plan.rows[0].errors).toEqual([]);
    expect(plan.validCount).toBe(1);
    expect(plan.migrateCount).toBe(0);
  });

  it("accepts a full address on the target domain (case-insensitively)", () => {
    const plan = planMailboxImport([{ email: "Sales@ACME.com", password: "Hunter2!xY" }], { domain: DOMAIN });
    expect(plan.rows[0].email).toBe("sales@acme.com");
    expect(plan.rows[0].errors).toEqual([]);
  });

  it("rejects an address on a different domain", () => {
    const plan = planMailboxImport([{ email: "sales@other.com", password: "Hunter2!xY" }], { domain: DOMAIN });
    expect(plan.rows[0].errors[0]).toMatch(/on other\.com, not acme\.com/);
    expect(plan.validCount).toBe(0);
    expect(plan.errorCount).toBe(1);
  });

  it("flags missing email and missing password", () => {
    const plan = planMailboxImport(
      [
        { email: "", password: "Hunter2!xY" },
        { email: "noPass", password: "" },
      ],
      { domain: DOMAIN },
    );
    expect(plan.rows[0].errors).toContain("missing email address");
    expect(plan.rows[1].errors).toContain("missing password");
    expect(plan.validCount).toBe(0);
  });

  it("marks duplicates within the sheet as errors on the later row", () => {
    const plan = planMailboxImport(
      [
        { email: "joe@acme.com", password: "Hunter2!xY" },
        { email: "JOE@acme.com", password: "Hunter2!xY" },
      ],
      { domain: DOMAIN },
    );
    expect(plan.rows[0].errors).toEqual([]);
    expect(plan.rows[1].errors[0]).toMatch(/duplicate of row 1/);
    expect(plan.validCount).toBe(1);
  });

  it("warns (but does not block) when the password looks too weak", () => {
    const plan = planMailboxImport([{ email: "weak", password: "short" }], { domain: DOMAIN });
    expect(plan.rows[0].errors).toEqual([]);
    expect(plan.rows[0].warnings[0]).toMatch(/password may not meet the policy/);
    expect(plan.validCount).toBe(1);
  });

  it("skips fully-empty rows and numbers data rows from 1", () => {
    const rows: RawImportRow[] = [
      { email: "a", password: "Hunter2!xY" },
      { email: "", password: "", imapHost: "", imapPassword: "" },
      { email: "b", password: "Hunter2!xY" },
    ];
    const plan = planMailboxImport(rows, { domain: DOMAIN });
    expect(plan.rows.map((r) => r.row)).toEqual([1, 2]);
    expect(plan.rows.map((r) => r.email)).toEqual(["a@acme.com", "b@acme.com"]);
  });

  it("builds a full IMAP source when host + password are present (user defaults to the email)", () => {
    const plan = planMailboxImport(
      [{ email: "joe", password: "Hunter2!xY", imapHost: "imap.old.com", imapPassword: "oldpw", imapSecurity: "SSL", imapPort: "993" }],
      { domain: DOMAIN },
    );
    const r = plan.rows[0];
    expect(r.willMigrate).toBe(true);
    expect(r.imap).toEqual({ host: "imap.old.com", port: 993, secure: true, user: "joe@acme.com", password: "oldpw" });
    expect(plan.migrateCount).toBe(1);
  });

  it("honors an explicit IMAP username over the email default", () => {
    const plan = planMailboxImport(
      [{ email: "joe", password: "Hunter2!xY", imapHost: "imap.old.com", imapPassword: "oldpw", imapUser: "legacy-login" }],
      { domain: DOMAIN },
    );
    expect(plan.rows[0].imap?.user).toBe("legacy-login");
  });

  it("treats partial IMAP details as a warning, still creating the mailbox without migrating", () => {
    const plan = planMailboxImport(
      [{ email: "joe", password: "Hunter2!xY", imapHost: "imap.old.com" }], // no IMAP password
      { domain: DOMAIN },
    );
    const r = plan.rows[0];
    expect(r.errors).toEqual([]);
    expect(r.willMigrate).toBe(false);
    expect(r.warnings[0]).toMatch(/incomplete IMAP details \(IMAP password\)/);
    expect(plan.validCount).toBe(1);
    expect(plan.migrateCount).toBe(0);
  });

  it("warns on an invalid port but still migrates with the default port", () => {
    const plan = planMailboxImport(
      [{ email: "joe", password: "Hunter2!xY", imapHost: "imap.old.com", imapPassword: "oldpw", imapPort: "not-a-port" }],
      { domain: DOMAIN },
    );
    expect(plan.rows[0].willMigrate).toBe(true);
    expect(plan.rows[0].imap?.port).toBeUndefined();
    expect(plan.rows[0].warnings[0]).toMatch(/invalid IMAP port/);
  });
});

describe("rowsFromGrid", () => {
  it("maps header aliases to canonical fields and ignores unknown columns", () => {
    const header = ["Email Address", "Password", "IMAP Server", "IMAP Password", "Notes"];
    const body = [["joe@acme.com", "Hunter2!xY", "imap.old.com", "oldpw", "ignore me"]];
    const raw = rowsFromGrid(header, body);
    expect(raw[0]).toEqual({ email: "joe@acme.com", password: "Hunter2!xY", imapHost: "imap.old.com", imapPassword: "oldpw" });

    const plan = planMailboxImport(raw, { domain: DOMAIN });
    expect(plan.rows[0].willMigrate).toBe(true);
    expect(plan.rows[0].errors).toEqual([]);
  });
});

describe("detectHeaderRow / planFromGrid", () => {
  it("finds the header row even when an intro row sits above it", () => {
    const grid = [
      ["Fill in one row per mailbox. IMAP columns are optional.", "", "", ""],
      ["Email address", "Password", "IMAP host (optional)", "IMAP password (optional)"],
      ["joe@acme.com", "Hunter2!xY", "imap.old.com", "oldpw"],
    ];
    expect(detectHeaderRow(grid)).toBe(1);
    const plan = planFromGrid(grid, { domain: DOMAIN });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].email).toBe("joe@acme.com");
    expect(plan.rows[0].willMigrate).toBe(true);
  });

  it("throws a user-facing error when there is no email column", () => {
    const grid = [
      ["Name", "Phone"],
      ["Joe", "555"],
    ];
    expect(detectHeaderRow(grid)).toBe(-1);
    expect(() => planFromGrid(grid, { domain: DOMAIN })).toThrow(/email.*column/i);
  });
});
