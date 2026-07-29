import type { ScheduledEvent } from "aws-lambda";
import { S3Client, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_RETENTION,
  normalizeRetention,
  retentionSettingsKey,
  shouldPurgeMessage,
  addressDomain,
  type RetentionSettings,
  type MessageMeta,
} from "@mailpoppy/core";

/**
 * Scheduled (EventBridge) retention enforcement (DESIGN §10). Reads the admin's
 * retention settings and:
 *   - always purges Trash older than `trashPurgeDays` (deleted mail), and
 *   - if a `retentionDays` window is set, hard-deletes ANY message older than it
 *     in every folder (data-minimisation). Default = keep mail indefinitely.
 *
 * Retention is resolved PER DOMAIN: each message uses its own domain's settings
 * (`retention#<domain>`), falling back to the deployment default
 * (`retention#default`) and then the built-in keep-forever default. A single
 * table scan applies the right window to each row.
 */
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INDEX_TABLE = process.env.INDEX_TABLE ?? "";
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";
const MAIL_BUCKET = process.env.MAIL_BUCKET ?? "";

/**
 * Load retention settings for a scope (a domain, or "default"). Returns null if
 * there's no doc for that scope; fail-safe: a malformed doc or read error is
 * treated as "no doc" so the caller falls back rather than surprise-deleting.
 */
async function loadRetentionScoped(scope: string): Promise<RetentionSettings | null> {
  if (!SETTINGS_TABLE) return null;
  try {
    const out = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: retentionSettingsKey(scope) } }));
    const json = out.Item?.json;
    if (typeof json !== "string") return null;
    return normalizeRetention(JSON.parse(json) as Partial<RetentionSettings>);
  } catch {
    return null;
  }
}

type Row = MessageMeta & { pk: string; sk: string };

/** Hard-delete a message row and its raw S3 object. */
async function deleteRow(row: Row): Promise<void> {
  if (row.s3Key) {
    await s3
      .send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: row.s3Key }))
      .catch((e) => console.error("s3 delete failed", row.s3Key, e));
  }
  await ddb.send(new DeleteCommand({ TableName: INDEX_TABLE, Key: { pk: row.pk, sk: row.sk } }));
}

export async function handler(_event: ScheduledEvent): Promise<void> {
  const now = Date.now();

  // Resolve a domain's retention once, with fallback to the deployment default.
  const cache = new Map<string, RetentionSettings>();
  const fallback = (await loadRetentionScoped("default")) ?? DEFAULT_RETENTION;
  cache.set("default", fallback);
  async function retentionFor(domain: string): Promise<RetentionSettings> {
    const key = (domain || "default").toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const resolved = (await loadRetentionScoped(key)) ?? fallback;
    cache.set(key, resolved);
    return resolved;
  }

  let lastKey: Record<string, unknown> | undefined;
  let scanned = 0;
  let purged = 0;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: INDEX_TABLE, ExclusiveStartKey: lastKey }));
    for (const item of res.Items ?? []) {
      const row = item as unknown as Row;
      scanned += 1;
      const domain = (row.domain || addressDomain(row.mailbox ?? "")).toLowerCase();
      const retention = await retentionFor(domain);
      if (shouldPurgeMessage({ folder: row.folder, date: row.date }, retention, now)) {
        await deleteRow(row);
        purged += 1;
      }
    }
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  console.log(`janitor scanned ${scanned} messages, purged ${purged} (per-domain retention)`);
}
