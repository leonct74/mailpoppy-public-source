/**
 * Append-only provisioning ledger (DESIGN §14.1 — resource transparency).
 *
 * CloudFormation is the source of truth for everything in the deployed *stack*,
 * but a few mutations happen OUTSIDE the stack via direct API calls in this
 * sidecar (Route53 records, the SES domain identity, SetActiveReceiptRuleSet).
 * Those have no CloudFormation record, so we log them here — every create/delete,
 * append-only — so the admin can see the *complete* footprint Mailpoppy touched
 * in their account, and audit it over time. Never throws into the caller: a
 * ledger write must never break (or mask) the provisioning operation itself.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type LedgerAction = "created" | "deleted" | "updated";

export interface LedgerEntry {
  ts: string; // ISO 8601
  action: LedgerAction;
  service: string; // "Route53" | "SES" | "S3" | ...
  resourceType: string; // e.g. "DKIM CNAME", "EmailIdentity", "ReceiptRuleSet"
  name: string; // resource name / DNS name / ARN
  region: string;
  detail?: string;
}

function ledgerPath(): string {
  return process.env.MAILPOPPY_LEDGER ?? join(homedir(), ".mailpoppy", "provisioning-ledger.json");
}

export async function readLedger(): Promise<LedgerEntry[]> {
  try {
    const raw = await fs.readFile(ledgerPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]) : [];
  } catch {
    return []; // missing/corrupt ledger reads as empty
  }
}

/** Append one or more entries. Best-effort: errors are logged, never thrown. */
export async function record(entries: Array<Omit<LedgerEntry, "ts"> & { ts?: string }>): Promise<void> {
  if (entries.length === 0) return;
  try {
    const path = ledgerPath();
    await fs.mkdir(dirname(path), { recursive: true });
    const existing = await readLedger();
    const now = new Date().toISOString();
    for (const e of entries) existing.push({ ts: now, ...e });
    await fs.writeFile(path, JSON.stringify(existing, null, 2), "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("ledger write failed (non-fatal):", err);
  }
}
