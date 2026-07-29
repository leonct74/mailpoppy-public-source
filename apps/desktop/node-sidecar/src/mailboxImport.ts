// Sidecar side of the bulk-mailbox import: the only place that touches a real
// spreadsheet (.xlsx/.csv) via ExcelJS. It reads an uploaded file into a plain
// grid of cells and hands it to the pure planner in @mailpoppy/core, and it
// generates the friendly downloadable template. All validation/normalization
// rules live in core — this module is just spreadsheet I/O.
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { planFromGrid, type MailboxImportPlan } from "@mailpoppy/core";

type Cell = string | number | null | undefined;

/** Coerce any ExcelJS cell value (rich text, hyperlink, formula, date…) to text. */
function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as { text?: unknown; richText?: { text?: string }[]; hyperlink?: unknown; result?: unknown };
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) return o.richText.map((t) => t.text ?? "").join("");
    if (o.hyperlink != null) return String(o.text ?? o.hyperlink);
    if (o.result != null) return String(o.result);
    return "";
  }
  return String(v);
}

function worksheetToGrid(ws: ExcelJS.Worksheet): Cell[][] {
  const grid: Cell[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[]; // 1-indexed array; [0] is undefined
    const cells: Cell[] = [];
    for (let c = 1; c < values.length; c++) cells.push(cellText(values[c]));
    grid.push(cells);
  });
  return grid;
}

/**
 * Detect common files that look plausible but ExcelJS can't read, and return a
 * clear, actionable message instead of a cryptic failure. The big one: an Apple
 * Numbers file is ALSO a zip ("PK…"), so it sails past the xlsx magic-byte check
 * and then loads with zero worksheets. We recognize it by its iWork payload entry
 * (or a .numbers/.pages/.key name) and tell the user how to export to Excel/CSV.
 */
function unsupportedFileMessage(buffer: Buffer, filename?: string): string | null {
  const name = (filename ?? "").toLowerCase();
  const isIWork = /\.(numbers|pages|key)$/.test(name) || buffer.includes(Buffer.from("Document.iwa"));
  if (isIWork) {
    return "This looks like an Apple Numbers file, which can't be read directly. In Numbers, choose File ▸ Export To ▸ Excel… (or CSV…), then upload that file.";
  }
  // Legacy binary Excel (.xls) is an OLE/CFB document (magic D0 CF 11 E0), not a zip.
  if (buffer.length >= 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return "This is an old Excel format (.xls). Please re-save it as Excel Workbook (.xlsx) or CSV, then upload that file.";
  }
  return null;
}

/** Read an uploaded workbook (xlsx by magic bytes, else CSV) into a cell grid. */
export async function readImportGrid(buffer: Buffer, filename?: string): Promise<Cell[][]> {
  const unsupported = unsupportedFileMessage(buffer, filename);
  if (unsupported) throw new Error(unsupported);

  const wb = new ExcelJS.Workbook();
  const isXlsx = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK" zip header
  if (isXlsx) {
    // The value is a real Node Buffer at runtime; cast through the call's own
    // parameter type to bridge the @types/node generic-Buffer / ExcelJS clash.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } else {
    // Anything else: treat as CSV (UTF-8). ExcelJS's CSV reader wants a stream.
    await wb.csv.read(Readable.from(buffer));
  }
  const sheet =
    wb.worksheets.find((w) => w.name.toLowerCase() === "mailboxes") ??
    wb.worksheets.find((w) => w.rowCount > 0) ??
    wb.worksheets[0];
  if (!sheet) {
    throw new Error("Couldn't find a sheet to read. Please upload an Excel (.xlsx) or CSV file — the template you downloaded works.");
  }
  return worksheetToGrid(sheet);
}

/** Parse + validate an uploaded file into an import plan for one domain. */
export async function planFromBuffer(buffer: Buffer, domain: string, filename?: string): Promise<MailboxImportPlan> {
  return planFromGrid(await readImportGrid(buffer, filename), { domain });
}

const BLUE = "FF1A73E8";
const GREY = "FFE8EAED";
const INK = "FF202124";
const MUTE = "FF5F6368";

/**
 * Build the downloadable .xlsx template. Two tabs:
 *   - "Mailboxes": an intro row + a styled header row the admin fills in. Required
 *     columns (email, password) are blue; the OPTIONAL IMAP columns are grey and
 *     literally say "(optional)" so a non-technical admin isn't intimidated. Each
 *     header carries a hover comment. The parser uses detectHeaderRow, so the
 *     intro row above the headers is harmless.
 *   - "How to use": plain-language guidance + a worked example.
 */
export async function buildTemplateWorkbook(domain: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Mailpoppy";
  wb.created = new Date();

  const ws = wb.addWorksheet("Mailboxes", { views: [{ state: "frozen", ySplit: 2 }] });

  ws.mergeCells("A1:G1");
  const intro = ws.getCell("A1");
  intro.value =
    `One row per mailbox on ${domain}. Only “Email address” and “Password” are required — ` +
    `leave the grey IMAP columns blank unless you also want to import a mailbox’s old mail.`;
  intro.font = { italic: true, color: { argb: MUTE } };
  intro.alignment = { wrapText: true, vertical: "middle" };
  ws.getRow(1).height = 32;

  const headers = [
    { text: "Email address", required: true, width: 28, note: `The full address (e.g. sales@${domain}) or just the part before the @ (e.g. sales). Required.` },
    { text: "Password", required: true, width: 22, note: "The new mailbox's own sign-in password. Required. At least 8 characters with upper & lower case, a number and a symbol." },
    { text: "IMAP host (optional)", required: false, width: 24, note: "OPTIONAL — only to import old mail. The old server, e.g. imap.gmail.com. Leave blank to just create an empty mailbox." },
    { text: "IMAP port (optional)", required: false, width: 18, note: "OPTIONAL. Usually 993. Leave blank to use the default." },
    { text: "IMAP username (optional)", required: false, width: 24, note: "OPTIONAL. The login on the OLD server, only if different from the email address above." },
    { text: "IMAP password (optional)", required: false, width: 26, note: "OPTIONAL. The password on the OLD server (NOT the new password in column B). Needed only to import old mail." },
    { text: "IMAP security (optional)", required: false, width: 22, note: "OPTIONAL. SSL/TLS (default) or STARTTLS." },
  ];
  const headerRow = ws.getRow(2);
  headers.forEach((h, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = h.text;
    cell.note = h.note;
    cell.font = { bold: true, color: { argb: h.required ? "FFFFFFFF" : INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: h.required ? BLUE : GREY } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    ws.getColumn(i + 1).width = h.width;
  });
  headerRow.height = 22;

  const help = wb.addWorksheet("How to use");
  help.getColumn(1).width = 104;
  const lines: { t: string; bold?: boolean }[] = [
    { t: "Importing mailboxes into Mailpoppy", bold: true },
    { t: "" },
    { t: "1. Fill in the “Mailboxes” tab — one row per mailbox you want to create." },
    { t: "2. Email address and Password are the ONLY required columns." },
    { t: `      • Email can be the full address (sales@${domain}) or just “sales”.` },
    { t: "      • Password is the new sign-in password for that mailbox." },
    { t: "3. Save the file and pick it back in Mailpoppy → your domain → Import from Excel." },
    { t: "" },
    { t: "Optional: also bring across someone's OLD email", bold: true },
    { t: "Most people just create empty mailboxes and skip this entirely — that's fine." },
    { t: "If you DO want to import old mail, also fill in the grey IMAP columns:" },
    { t: "      • IMAP host + IMAP password are the minimum needed." },
    { t: "      • IMAP username defaults to the email address if left blank." },
    { t: "      • IMAP port defaults to 993; security defaults to SSL/TLS." },
    { t: "" },
    { t: "Example", bold: true },
    { t: "email address          password          imap host          imap password" },
    { t: "sales                  S@les2026!        (blank)            (blank)          → just creates the mailbox" },
    { t: `joe@${domain}      Welcome!23        imap.gmail.com     app-password     → creates AND imports old mail` },
  ];
  lines.forEach((l, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = l.t;
    cell.font = { bold: !!l.bold, color: { argb: INK } };
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

/**
 * Generate the template and write it to disk, returning where it landed. The
 * webview can't honor a blob `<a download>` (and the opener plugin only allows
 * http/https), so the sidecar — which is local to the user's machine and already
 * has filesystem access — saves the file itself. Prefers the user's Downloads
 * folder; falls back to the OS temp dir if Downloads is missing or not writable
 * (e.g. a macOS TCC prompt was declined).
 */
export async function saveTemplate(domain: string): Promise<{ path: string; filename: string; dir: string }> {
  const buf = await buildTemplateWorkbook(domain);
  const filename = `mailpoppy-mailboxes-${domain}.xlsx`;
  let lastErr: unknown;
  for (const dir of [join(homedir(), "Downloads"), tmpdir()]) {
    if (!existsSync(dir)) continue;
    try {
      const path = join(dir, filename);
      await writeFile(path, buf);
      return { path, filename, dir };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("could not write the template file");
}
