/**
 * Phase 4 — migrate existing mail (AWS WorkMail, or any IMAP server) into a
 * Mailpoppy mailbox before the source is decommissioned (WorkMail cutoff).
 *
 * Runs in the desktop sidecar (the admin/provisioning plane): it connects to the
 * source server with the *user's IMAP credentials* (which never leave this
 * machine) and writes the fetched mail straight into the deployed backend's S3
 * bucket (raw .eml + extracted attachments) and DynamoDB index — producing rows
 * IDENTICAL to what the inbound Lambda creates, so the existing inbox/access-API
 * render imported mail with no special-casing. Idempotent: the row id is a hash
 * of the raw bytes, so re-running never duplicates.
 */
import { createHash } from "node:crypto";
import { ImapFlow, type ListResponse } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { fromIni } from "@aws-sdk/credential-providers";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  type MessageMeta,
  type EmailAddress,
  type AttachmentMeta,
  type Folder,
  mailboxPk,
  messageSk,
  deriveThreadId,
  normalizeAddress,
  attachmentS3Key,
  mapImapFolder,
  imapFlagsToFlags,
  isImapDeleted,
} from "@mailpoppy/core";
import type { AwsContext } from "./provisioning";
import { record } from "./ledger";

export interface ImapSource {
  host: string;
  port?: number; // default 993 (or 143 when secure=false)
  secure?: boolean; // default true (implicit TLS)
  user: string;
  password: string;
}

export interface MigrateTarget {
  /** Destination mailbox owner address (the DynamoDB partition). */
  mailbox: string;
  /** S3 mail bucket name (from the deployed stack outputs). */
  bucket: string;
  /** DynamoDB index table name (from the deployed stack outputs). */
  indexTable: string;
}

export interface MigrateOptions {
  source: ImapSource;
  target: MigrateTarget;
  /** Limit to these IMAP folder paths; default = all selectable folders. */
  folders?: string[];
  /** Safety cap on total messages imported in one run. */
  maxMessages?: number;
  /** Count only — don't fetch bodies or write anything. */
  dryRun?: boolean;
}

export interface ImapFolderInfo {
  path: string;
  name: string;
  specialUse?: string;
  mappedFolder: Folder;
  messages: number;
}

export interface FolderResult {
  path: string;
  mappedFolder: Folder;
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

const INBOUND_PREFIX = "inbound/";

function makeImap(src: ImapSource): ImapFlow {
  return new ImapFlow({
    host: src.host,
    port: src.port ?? (src.secure === false ? 143 : 993),
    secure: src.secure ?? true,
    auth: { user: src.user, pass: src.password },
    logger: false, // we surface our own progress; imapflow's pino logs are noise
  });
}

function firstFrom(parsed: AddressObject | AddressObject[] | undefined): EmailAddress {
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  const v = obj?.value?.[0];
  return { name: v?.name || undefined, address: normalizeAddress(v?.address) };
}

function toList(to: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!to) return [];
  const objs = Array.isArray(to) ? to : [to];
  return objs.flatMap((o) =>
    (o.value ?? []).map((v) => ({ name: v.name || undefined, address: normalizeAddress(v.address) })),
  );
}

/** Stable, key-safe row id: a hash of the raw bytes → idempotent re-imports. */
export function migrationMessageId(raw: Buffer | string): string {
  return "mig-" + createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/** Connect, enumerate folders with message counts, disconnect. No writes. */
export async function testImap(src: ImapSource): Promise<{ ok: true; folders: ImapFolderInfo[] }> {
  const client = makeImap(src);
  await client.connect();
  try {
    const list = await client.list();
    const folders: ImapFolderInfo[] = [];
    for (const f of list as ListResponse[]) {
      if (f.flags?.has("\\Noselect")) continue;
      let messages = 0;
      try {
        const st = await client.status(f.path, { messages: true });
        messages = st.messages ?? 0;
      } catch {
        messages = 0;
      }
      folders.push({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse,
        mappedFolder: mapImapFolder(f.path, f.specialUse),
        messages,
      });
    }
    return { ok: true, folders };
  } finally {
    await client.logout().catch(() => {});
  }
}

export async function migrate(ctx: AwsContext, opts: MigrateOptions): Promise<MigrateSummary> {
  const { source, target } = opts;
  // ignoreCache: re-read ~/.aws/credentials fresh — the profile may have been
  // written this session (see provisioning.clients for the full rationale).
  const credentials = ctx.profile ? fromIni({ profile: ctx.profile, ignoreCache: true }) : undefined;
  const s3 = new S3Client({ region: ctx.region, credentials });
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: ctx.region, credentials }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const maxMessages = opts.maxMessages ?? 5000;
  const dryRun = opts.dryRun ?? false;
  const client = makeImap(source);
  await client.connect();

  const results: FolderResult[] = [];
  let totalImported = 0;
  let totalSkipped = 0;

  try {
    const list = (await client.list()) as ListResponse[];
    const selectable = list.filter((f) => !f.flags?.has("\\Noselect"));
    const chosen = opts.folders?.length
      ? selectable.filter((f) => opts.folders!.includes(f.path))
      : selectable;

    for (const f of chosen) {
      const mappedFolder = mapImapFolder(f.path, f.specialUse);
      let imported = 0;
      let skipped = 0;

      if (dryRun) {
        const st = await client.status(f.path, { messages: true });
        results.push({ path: f.path, mappedFolder, imported: st.messages ?? 0, skipped: 0 });
        continue;
      }

      const lock = await client.getMailboxLock(f.path);
      try {
        for await (const msg of client.fetch("1:*", { source: true, flags: true, internalDate: true })) {
          if (totalImported >= maxMessages) break;
          const flags = Array.from(msg.flags ?? []);
          const raw = msg.source;
          if (!raw || isImapDeleted(flags)) {
            skipped++;
            continue;
          }

          const messageId = migrationMessageId(raw);
          const parsed = await simpleParser(raw);
          const from = firstFrom(parsed.from);
          const to = toList(parsed.to);
          const threadId =
            deriveThreadId({
              references: parsed.references ?? null,
              inReplyTo: parsed.inReplyTo ?? null,
              messageId: parsed.messageId ?? messageId,
            }) || messageId;

          // Extract attachments to their own S3 objects (mirrors inbound-processor).
          const attachments: AttachmentMeta[] = [];
          const parsedAttachments = parsed.attachments ?? [];
          for (let i = 0; i < parsedAttachments.length; i++) {
            const a = parsedAttachments[i]!;
            const filename = a.filename ?? `attachment-${i}`;
            const contentType = a.contentType ?? "application/octet-stream";
            const akey = attachmentS3Key(messageId, i, filename);
            await s3.send(
              new PutObjectCommand({ Bucket: target.bucket, Key: akey, Body: a.content, ContentType: contentType }),
            );
            attachments.push({ filename, contentType, sizeBytes: a.size ?? a.content?.length ?? 0, s3Key: akey });
          }

          const s3Key = `${INBOUND_PREFIX}${messageId}`;
          await s3.send(
            new PutObjectCommand({
              Bucket: target.bucket,
              Key: s3Key,
              Body: raw,
              ContentType: "message/rfc822",
            }),
          );

          // The sort key embeds the date, so it MUST be deterministic for a given
          // message or a re-run produces a duplicate row. Prefer the Date header,
          // fall back to the IMAP INTERNALDATE (server-assigned, stable across
          // fetches), and only then to epoch — never `new Date()`.
          const internal = msg.internalDate ? new Date(msg.internalDate) : new Date(0);
          const date = (parsed.date ?? internal).toISOString();
          const meta: MessageMeta = {
            domain: (target.mailbox.split("@")[1] ?? "").toLowerCase(),
            mailbox: normalizeAddress(target.mailbox),
            messageId,
            threadId,
            folder: mappedFolder,
            from,
            to,
            subject: parsed.subject ?? "(no subject)",
            snippet: (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
            date,
            flags: imapFlagsToFlags(flags),
            hasAttachments: attachments.length > 0,
            attachments: attachments.length > 0 ? attachments : undefined,
            s3Key,
            sizeBytes: typeof raw === "string" ? Buffer.byteLength(raw) : raw.length,
          };

          await ddb.send(
            new PutCommand({
              TableName: target.indexTable,
              Item: { pk: mailboxPk(target.mailbox), sk: messageSk(mappedFolder, date, messageId), ...meta },
            }),
          );
          imported++;
          totalImported++;
        }
      } finally {
        lock.release();
      }

      results.push({ path: f.path, mappedFolder, imported, skipped });
      totalSkipped += skipped;
    }
  } finally {
    await client.logout().catch(() => {});
  }

  if (!dryRun && totalImported > 0) {
    await record([
      {
        action: "created",
        service: "Migration",
        resourceType: "Imported mail",
        name: `${totalImported} messages → ${normalizeAddress(target.mailbox)}`,
        region: ctx.region,
        detail: `from IMAP ${source.host} into ${target.indexTable} / ${target.bucket}`,
      },
    ]);
  }

  return {
    host: source.host,
    mailbox: normalizeAddress(target.mailbox),
    dryRun,
    folders: results,
    totalImported,
    totalSkipped,
  };
}
