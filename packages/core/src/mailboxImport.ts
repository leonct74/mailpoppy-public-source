// Pure logic for the bulk "import mailboxes from a spreadsheet" feature.
// Everything here is deterministic and side-effect-free: the sidecar turns an
// uploaded .xlsx/.csv into raw header→value rows (with ExcelJS), then hands them
// here to be normalized, validated and turned into a concrete import plan. The
// desktop UI renders that plan as a preview table and drives the per-row work by
// calling the existing single-mailbox / migration endpoints. Keeping the rules
// here means they're unit-tested without a real workbook, a DOM or AWS.
//
// A row may do two things: (1) create a sign-in mailbox (email + password — both
// REQUIRED), and (2) OPTIONALLY import old mail over IMAP if the IMAP columns are
// filled in. The IMAP columns are entirely optional — a sheet with just email +
// password is the common case.

import { normalizeAddress, addressDomain } from "./mailbox";

/** A single spreadsheet row as raw header→cell values (already stringified by the reader). */
export type RawImportRow = Record<string, string | number | boolean | null | undefined>;

/** Resolved IMAP source for a row that opts into migration. */
export interface ImportImapSource {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
}

/** One row after normalization + validation. */
export interface PlannedImportRow {
  /** 1-based position among the data rows (for human-readable messages). */
  row: number;
  /** Normalized full address (lowercased, on the target domain). "" if unparseable. */
  email: string;
  /** The new mailbox sign-in password (verbatim — never logged). */
  password: string;
  /** True when this row carries a complete IMAP source and should also migrate. */
  willMigrate: boolean;
  /** Present iff willMigrate. */
  imap?: ImportImapSource;
  /** Hard problems — the row is excluded from the import. */
  errors: string[];
  /** Soft notes — the row is still imported (e.g. partial IMAP that we ignore). */
  warnings: string[];
}

export interface MailboxImportPlan {
  domain: string;
  rows: PlannedImportRow[];
  /** Rows with no errors (these will be created). */
  validCount: number;
  /** Rows that will also migrate mail. */
  migrateCount: number;
  /** Rows excluded because of errors. */
  errorCount: number;
}

/** Canonical field a header maps to. */
type Field = "email" | "password" | "imapHost" | "imapPort" | "imapUser" | "imapPassword" | "imapSecurity";

// Header aliases — admins won't all name columns identically, and the template's
// own headers carry "(optional)" notes we strip. Matching is done on a normalized
// header (lowercased, parentheticals removed, non-alphanumerics → "_").
const HEADER_ALIASES: Record<Field, string[]> = {
  email: ["email", "email_address", "e_mail", "address", "mailbox", "mailbox_address"],
  password: ["password", "pass", "mailbox_password", "new_password", "temporary_password", "temp_password", "sign_in_password"],
  imapHost: ["imap_host", "host", "imap_server", "server", "incoming_server", "incoming_mail_server"],
  imapPort: ["imap_port", "port"],
  imapUser: ["imap_user", "imap_username", "imap_login", "username", "user", "login"],
  imapPassword: ["imap_password", "imap_pass", "source_password", "old_password", "current_password"],
  imapSecurity: ["imap_security", "security", "encryption", "imap_encryption", "ssl_tls"],
};

/** Canonical, machine-matchable headers used in the generated template. */
export const TEMPLATE_HEADERS: Record<Field, string> = {
  email: "email",
  password: "password",
  imapHost: "imap_host",
  imapPort: "imap_port",
  imapUser: "imap_user",
  imapPassword: "imap_password",
  imapSecurity: "imap_security",
};

export const REQUIRED_FIELDS: Field[] = ["email", "password"];
export const OPTIONAL_IMAP_FIELDS: Field[] = ["imapHost", "imapPort", "imapUser", "imapPassword", "imapSecurity"];

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ") // drop "(optional)" etc.
    .replace(/[^a-z0-9]+/g, "_") // non-alphanumerics → underscore
    .replace(/^_+|_+$/g, "") // trim leading/trailing underscores
    .replace(/_+/g, "_"); // collapse repeats
}

/** Build a header→field lookup for a sheet's header row. Last match wins per field. */
function mapHeaders(headers: string[]): Map<number, Field> {
  const lookup = new Map<string, Field>();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [Field, string[]][]) {
    for (const a of aliases) lookup.set(a, field);
  }
  const byIndex = new Map<number, Field>();
  headers.forEach((raw, i) => {
    const field = lookup.get(normalizeHeader(String(raw ?? "")));
    if (field) byIndex.set(i, field);
  });
  return byIndex;
}

function cell(v: RawImportRow[string]): string {
  return v == null ? "" : String(v).trim();
}

/**
 * Interpret a "security" cell into an implicit-TLS flag.
 *   SSL / TLS / implicit / 993  → secure: true (default)
 *   STARTTLS / none / plain / 143 → secure: false
 * Returns undefined when the cell is blank (caller applies the default).
 */
export function parseImapSecurity(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (/start|^143$|none|plain|insecure/.test(s)) return false;
  if (/ssl|tls|implicit|^993$|secure/.test(s)) return true;
  return undefined;
}

// Mirrors the Cognito pool password policy surfaced in the UI. A failure here is a
// WARNING, not an error — Cognito is the source of truth and will reject at create
// time; we just give the admin a heads-up before they run a big import.
const PASSWORD_HINT = "password may not meet the policy (min 8 chars, with upper & lower case, a number and a symbol)";
function looksWeak(pw: string): boolean {
  return !(pw.length >= 8 && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw));
}

// Accept a full address (must be on the target domain) OR a bare local part (we
// append @domain). Conservative local-part check — Cognito/SES validate for real.
const LOCAL_PART = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;

/**
 * Turn raw spreadsheet rows into a validated, de-duplicated import plan for one
 * domain. The header row is matched by alias; data rows that are entirely empty
 * are skipped. Every returned row is either valid (no errors) or carries the
 * reasons it can't be imported, so the UI can show a complete preview.
 */
export function planMailboxImport(
  rawRows: RawImportRow[],
  opts: { domain: string },
): MailboxImportPlan {
  const domain = opts.domain.trim().toLowerCase();
  const rows: PlannedImportRow[] = [];
  const seen = new Map<string, number>(); // email → first row number

  let dataRow = 0;
  for (const raw of rawRows) {
    // Skip fully-empty rows (trailing blanks are common in spreadsheets).
    const values = Object.values(raw).map(cell);
    if (values.every((v) => v === "")) continue;
    dataRow += 1;

    const errors: string[] = [];
    const warnings: string[] = [];

    // ---- Address ----
    const rawEmail = cell(raw.email);
    let email = "";
    if (!rawEmail) {
      errors.push("missing email address");
    } else if (rawEmail.includes("@")) {
      email = normalizeAddress(rawEmail);
      const dom = addressDomain(email);
      if (!email || !dom) errors.push(`"${rawEmail}" is not a valid email address`);
      else if (dom !== domain) errors.push(`address is on ${dom}, not ${domain}`);
    } else if (LOCAL_PART.test(rawEmail)) {
      email = `${rawEmail.toLowerCase()}@${domain}`;
    } else {
      errors.push(`"${rawEmail}" is not a valid email address`);
    }

    if (email) {
      const dup = seen.get(email);
      if (dup) errors.push(`duplicate of row ${dup}`);
      else seen.set(email, dataRow);
    }

    // ---- Password ----
    const password = cell(raw.password);
    if (!password) errors.push("missing password");
    else if (looksWeak(password)) warnings.push(PASSWORD_HINT);

    // ---- Optional IMAP (only if the admin filled any IMAP column) ----
    const host = cell(raw.imapHost);
    const imapPassword = cell(raw.imapPassword);
    const imapUser = cell(raw.imapUser);
    const portRaw = cell(raw.imapPort);
    const securityRaw = cell(raw.imapSecurity);
    const anyImap = host || imapPassword || imapUser || portRaw || securityRaw;

    let willMigrate = false;
    let imap: ImportImapSource | undefined;
    if (anyImap) {
      const missing: string[] = [];
      if (!host) missing.push("IMAP host");
      if (!imapPassword) missing.push("IMAP password");
      if (missing.length) {
        // Partial IMAP details — don't migrate, but don't block the mailbox either.
        warnings.push(`incomplete IMAP details (${missing.join(", ")}) — the mailbox is created, but no mail is imported`);
      } else {
        let port: number | undefined;
        if (portRaw) {
          const n = Number(portRaw);
          if (!Number.isInteger(n) || n <= 0 || n > 65535) warnings.push(`ignoring invalid IMAP port "${portRaw}"`);
          else port = n;
        }
        imap = {
          host,
          port,
          secure: parseImapSecurity(securityRaw),
          user: imapUser || email,
          password: imapPassword,
        };
        willMigrate = true;
      }
    }

    rows.push({ row: dataRow, email, password, willMigrate, imap, errors, warnings });
  }

  const validCount = rows.filter((r) => r.errors.length === 0).length;
  const migrateCount = rows.filter((r) => r.errors.length === 0 && r.willMigrate).length;
  return { domain, rows, validCount, migrateCount, errorCount: rows.length - validCount };
}

/**
 * Convenience: given the sheet's header row and the body rows as arrays of cell
 * values (what a spreadsheet reader naturally produces), build the keyed
 * RawImportRow[] the planner expects. Unknown columns are ignored.
 */
export function rowsFromGrid(header: (string | number | null | undefined)[], body: RawImportRow[string][][]): RawImportRow[] {
  const fields = mapHeaders(header.map((h) => String(h ?? "")));
  return body.map((cells) => {
    const row: RawImportRow = {};
    fields.forEach((field, idx) => {
      row[field] = cells[idx];
    });
    return row;
  });
}

/**
 * Find the header row in a raw grid (array of rows of cells): the first row that
 * carries a column we recognize as the email column. This lets a sheet have an
 * intro/title row above the headers and still parse. Returns the row index, or -1
 * when no email column is found anywhere.
 */
export function detectHeaderRow(grid: (string | number | null | undefined)[][]): number {
  for (let i = 0; i < grid.length; i++) {
    const fields = mapHeaders((grid[i] ?? []).map((c) => String(c ?? "")));
    for (const field of fields.values()) if (field === "email") return i;
  }
  return -1;
}

/**
 * End-to-end: take a raw spreadsheet grid (header row somewhere near the top,
 * data below it), locate the header, and build the validated plan. Throws a
 * user-facing Error when no recognizable email column is present.
 */
export function planFromGrid(grid: (string | number | null | undefined)[][], opts: { domain: string }): MailboxImportPlan {
  const headerIdx = detectHeaderRow(grid);
  if (headerIdx === -1) {
    throw new Error(
      "Couldn't find an “email” column. Make sure the first row names the columns (download the template for the exact names).",
    );
  }
  const header = grid[headerIdx] ?? [];
  const body = grid.slice(headerIdx + 1);
  return planMailboxImport(rowsFromGrid(header, body), opts);
}
