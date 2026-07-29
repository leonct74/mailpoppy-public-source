// Desktop client for the sidecar's Phase 4 migration endpoints (WorkMail / any
// IMAP → the deployed MailPoppy backend). The actual IMAP fetch + S3/DynamoDB
// writes happen in the sidecar (admin plane); this is just the typed transport.
import { sidecar } from "./sidecar";

export interface ImapSourceInput {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  password: string;
}

export interface ImapFolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  mappedFolder: string;
  messages: number;
}

export interface FolderResult {
  path: string;
  mappedFolder: string;
  imported: number;
  skipped: number;
}

export interface MigrateSummary {
  host: string;
  mailbox: string;
  dryRun: boolean;
  folders: FolderResult[];
  totalImported: number;
  totalSkipped: number;
}

export interface RunInput {
  source: ImapSourceInput;
  mailbox: string;
  stackName?: string;
  folders?: string[];
  maxMessages?: number;
  dryRun?: boolean;
}

const POST = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Verify IMAP credentials and list folders + message counts (no writes). */
export function testImap(src: ImapSourceInput): Promise<{ ok: true; folders: ImapFolderInfo[] }> {
  return sidecar("/migrate/imap/test", POST(src));
}

/** Run the import (or a dry-run preview). Returns the per-folder summary. */
export function runMigration(input: RunInput): Promise<MigrateSummary & { ok: true }> {
  return sidecar("/migrate/imap/run", POST(input));
}
