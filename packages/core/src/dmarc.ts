// DMARC aggregate ("rua") report model (DESIGN §13 / §18 Phase 5).
//
// When a domain publishes a DMARC record (Mailpoppy does this at provisioning:
// `_dmarc.<domain> TXT "v=DMARC1; p=none; rua=mailto:postmaster@<domain>"`),
// inbox providers (Gmail, Yahoo, Microsoft…) email back a DAILY aggregate report:
// a small XML file (usually gzip- or zip-compressed) summarising every source
// that sent mail claiming to be from the domain, and whether that mail passed
// SPF/DKIM **alignment** (i.e. DMARC). This is the only genuinely per-domain
// authentication signal a customer's own AWS account gets for free.
//
// These helpers are intentionally dependency-free (core is shared with the React
// frontend): a small block-scoped extractor parses the fixed, machine-generated
// RFC 7489 schema, and pure functions turn a report into the per-domain counters
// the inbound-processor Lambda accumulates. Decompression (gzip/zip) is the
// Lambda's job — by the time `parseDmarcAggregate` runs, it has plain XML text.

import type { HealthLevel } from "./deliverability";

/** One `<record>` row from an aggregate report (only the fields we score). */
export interface DmarcRecordRow {
  /** The sending source's IP (informational; not currently surfaced). */
  sourceIp?: string;
  /** Number of messages this row represents. */
  count: number;
  /** DMARC-evaluated DKIM alignment result ("pass" | "fail" | other). */
  dkim?: string;
  /** DMARC-evaluated SPF alignment result ("pass" | "fail" | other). */
  spf?: string;
  /** The From-header domain the row is about. */
  headerFrom?: string;
}

/** A parsed DMARC aggregate report. */
export interface DmarcAggregateReport {
  /** The reporter (e.g. "google.com"). */
  orgName?: string;
  /** The reporter's report id (for dedupe/debugging). */
  reportId?: string;
  /** The domain the report is ABOUT (policy_published.domain), lower-cased. */
  domain?: string;
  /** Report window start (unix seconds). */
  begin?: number;
  /** Report window end (unix seconds). */
  end?: number;
  rows: DmarcRecordRow[];
}

/** Per-domain rollup of one or more reports. */
export interface DmarcSummary {
  domain?: string;
  /** Total messages reported. */
  volume: number;
  /** Messages that passed DMARC (SPF- or DKIM-aligned). */
  pass: number;
  /** Messages that failed DMARC. */
  fail: number;
}

/** Which container an attachment is, or null if it isn't a report candidate. */
export type DmarcAttachmentKind = "gzip" | "zip" | "xml";

// ---- XML extraction (block-scoped, no dependency) ---------------------------
// Aggregate reports are machine-generated and follow a fixed, attribute-light
// schema. We never parse arbitrary HTML/XML — only this known shape — so a small
// scoped tag reader is robust enough and keeps `core` free of an XML-parser dep.
// We always scope leaf reads to a parent block (e.g. read <domain> *inside*
// <policy_published>), so same-named tags elsewhere can't cross-contaminate.

/** Inner text of the first `<name …>…</name>` within `xml`, or undefined. */
function block(xml: string | undefined, name: string): string | undefined {
  if (!xml) return undefined;
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : undefined;
}

/** Inner text of EVERY `<name …>…</name>` within `xml`. */
function blocks(xml: string | undefined, name: string): string[] {
  if (!xml) return [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]!);
  return out;
}

/** Trimmed leaf text of `<name>` within `xml`. */
function text(xml: string | undefined, name: string): string | undefined {
  const inner = block(xml, name);
  if (inner === undefined) return undefined;
  const t = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  return t.length ? t : undefined;
}

function int(v: string | undefined): number {
  const n = parseInt((v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a DMARC aggregate report's XML. Returns null if `xml` isn't a DMARC
 * report (no `<feedback>` root) — callers treat that as "not a report" and move
 * on. Tolerant of an XML prolog, namespaces/attributes on the root, whitespace,
 * and CDATA in leaf values.
 */
export function parseDmarcAggregate(xml: string): DmarcAggregateReport | null {
  if (!xml || !/<feedback[\s>]/i.test(xml)) return null;
  const feedback = block(xml, "feedback") ?? xml;

  const metadata = block(feedback, "report_metadata");
  const dateRange = block(metadata, "date_range");
  const policy = block(feedback, "policy_published");

  const rows: DmarcRecordRow[] = blocks(feedback, "record").map((rec) => {
    const row = block(rec, "row");
    const evaluated = block(row, "policy_evaluated");
    const identifiers = block(rec, "identifiers");
    return {
      sourceIp: text(row, "source_ip"),
      count: int(text(row, "count")),
      dkim: text(evaluated, "dkim")?.toLowerCase(),
      spf: text(evaluated, "spf")?.toLowerCase(),
      headerFrom: text(identifiers, "header_from")?.toLowerCase(),
    };
  });

  const domain = (text(policy, "domain") ?? rows.find((r) => r.headerFrom)?.headerFrom)?.toLowerCase();

  return {
    orgName: text(metadata, "org_name"),
    reportId: text(metadata, "report_id"),
    domain,
    begin: text(dateRange, "begin") ? int(text(dateRange, "begin")) : undefined,
    end: text(dateRange, "end") ? int(text(dateRange, "end")) : undefined,
    rows,
  };
}

/**
 * Did this row pass DMARC? DMARC passes when EITHER SPF or DKIM is aligned-pass
 * (the `policy_evaluated` results are already the aligned outcomes), regardless
 * of disposition. Anything not an explicit "pass" counts as a fail.
 */
export function dmarcRowPasses(row: DmarcRecordRow): boolean {
  return row.dkim === "pass" || row.spf === "pass";
}

/** Roll a single report up into per-domain pass/fail counters. */
export function summarizeAggregate(report: DmarcAggregateReport): DmarcSummary {
  let volume = 0;
  let pass = 0;
  for (const row of report.rows) {
    const c = Math.max(0, row.count);
    volume += c;
    if (dmarcRowPasses(row)) pass += c;
  }
  return { domain: report.domain, volume, pass, fail: volume - pass };
}

/**
 * Classify a DMARC report attachment by filename + content type. Returns the
 * container kind so the Lambda knows how to decompress, or null if it isn't a
 * report candidate. (gzip is checked before zip because "application/gzip"
 * contains the substring "zip".)
 */
export function dmarcAttachmentKind(
  filename: string | undefined,
  contentType: string | undefined,
): DmarcAttachmentKind | null {
  const name = (filename ?? "").toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  if (name.endsWith(".gz") || name.endsWith(".xml.gz") || ct.includes("gzip") || ct.includes("x-gzip")) return "gzip";
  if (name.endsWith(".zip") || ct === "application/zip" || ct === "application/x-zip-compressed") return "zip";
  if (name.endsWith(".xml") || ct.includes("xml")) return "xml";
  return null;
}

// ---- Per-domain DMARC health (display) --------------------------------------
// A DMARC *fail* doesn't always mean abuse — a mailing list or a legitimate
// forwarder can break SPF/DKIM alignment too. So we treat this as an ADVISORY
// signal, classified more leniently than bounces/complaints, and never fold it
// into the domain's main health chip (which stays bounce/complaint driven).

/** Aggregate DMARC counters for one domain over the reporting window. */
export interface DomainDmarc {
  /** Number of report files ingested. */
  reports: number;
  /** Total messages those reports covered. */
  volume: number;
  /** Messages that passed DMARC. */
  pass: number;
  /** Messages that failed DMARC. */
  fail: number;
  /** Fraction (0..1) of `volume` that failed. */
  failRate: number;
  /** How many days the counters cover. */
  windowDays: number;
}

/**
 * Advisory health from a domain's DMARC fail rate. Lenient (forwarders cause
 * benign fails): watch at 5%, flag at 20%. "good" until there's enough volume
 * to be meaningful so a single forwarded message can't raise a false alarm.
 */
export function dmarcHealth(d: DomainDmarc | null | undefined): HealthLevel {
  if (!d || d.volume < 20) return "good";
  if (d.failRate >= 0.2) return "action";
  if (d.failRate >= 0.05) return "watch";
  return "good";
}
