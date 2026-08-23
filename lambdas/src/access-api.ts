import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand, type MessageHeader } from "@aws-sdk/client-sesv2";
import { randomUUID } from "node:crypto";
import {
  type MessageMeta,
  type Folder,
  type MessageFlags,
  type AttachmentMeta,
  SES_MAX_MESSAGE_BYTES,
  mailboxPk,
  messageSk,
  folderPrefix,
  normalizeAddress,
  resolveSenderAddress,
  attachmentS3Key,
  resolveContentType,
  buildMimeMessage,
  quotaSettingsKey,
  devicesSettingsKey,
  isExpoPushToken,
  addDeviceToken,
  removeDeviceToken,
  pruneDeviceTokens,
  type DeviceRegistry,
  sendSettingsKey,
  normalizeSendSettings,
  type SendSettings,
  formatBytes,
  mailboxKeysKey,
  isMailboxKeyRecord,
  type MailboxKeyRecord,
  isUnverifiedRecipientError,
} from "@mailpoppy/core";

/**
 * The Cognito-authorized access API (behind an API Gateway HTTP API with a JWT
 * authorizer). This is the single audited place that enforces "user X can act on
 * ONLY X's mailbox": the set of addresses a request may touch is derived purely
 * from the verified JWT claims — never from the path, query or body. Security-
 * critical multi-tenant isolation (DESIGN §6). Shared by desktop + mobile.
 *
 * Routes: GET /messages · GET /messages/{id}/raw · PATCH /messages/{id}/flags
 *        · POST /messages/{id}/move · POST /send · GET|PUT /mailbox-keys
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const ses = new SESv2Client({});

/**
 * A send SES refused for a reason the USER can fix — today: the account is still
 * in Amazon's sending sandbox, so it only delivers to addresses verified with
 * AWS. That is a normal setup state, not a server fault, so it must never fall
 * through to the generic 500 ("The mail server ran into a problem…") which tells
 * the user nothing and reads like an outage. Field report 2026-08-23: an admin
 * waiting on AWS production approval saw exactly that on every send.
 */
class SendRejected extends Error {}

/** Send through SES, translating a user-fixable rejection into {@link SendRejected}. */
async function sesSend(cmd: SendEmailCommand): Promise<{ MessageId?: string }> {
  try {
    return await ses.send(cmd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isUnverifiedRecipientError(msg)) {
      throw new SendRejected(
        "Your message wasn't sent. Amazon still has this AWS account in its sending " +
          "sandbox, so it only delivers to addresses that have been verified with AWS. " +
          "Once Amazon approves production access you can write to anyone; until then, " +
          "verify a recipient (or check the request's progress) in MailPoppy's setup " +
          "under Sending access.",
      );
    }
    throw err;
  }
}

const INDEX_TABLE = process.env.INDEX_TABLE ?? "";
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";
const MAIL_BUCKET = process.env.MAIL_BUCKET ?? "";
const BY_MESSAGE_INDEX = process.env.BY_MESSAGE_INDEX ?? "by-message";
const SENT_PREFIX = process.env.SENT_PREFIX ?? "sent/";
const DRAFTS_PREFIX = process.env.DRAFTS_PREFIX ?? "drafts/";
// Large attachments are uploaded straight to S3 under this prefix (via a presigned
// PUT), then pulled into the outgoing message by /send. A bucket lifecycle rule
// expires anything left here, so abandoned uploads clean themselves up.
const STAGING_PREFIX = process.env.STAGING_PREFIX ?? "outbound-staging/";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Strip the internal DynamoDB key attributes, returning just the public shape. */
function toMeta(item: Record<string, unknown>): MessageMeta {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest as unknown as MessageMeta;
}

/** The deployment's outbound settings (admin-set max attachment size, etc.). */
async function loadSendSettings(): Promise<SendSettings> {
  if (!SETTINGS_TABLE) return normalizeSendSettings(null);
  try {
    const res = await ddb.send(
      new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: sendSettingsKey() } }),
    );
    return normalizeSendSettings(res.Item as Partial<SendSettings> | undefined);
  } catch {
    return normalizeSendSettings(null);
  }
}

/**
 * The staging-key prefix segment that belongs to this caller. Presign writes keys
 * under it and /send only accepts keys under it, so one user can never reference
 * another user's staged upload (defense in depth, like the rest of this file).
 */
function stagingOwnerSegment(owned: string[]): string {
  return (owned[0] ?? "unknown").replace(/[^a-z0-9._-]+/gi, "_");
}

/**
 * The addresses this request is allowed to touch — derived ONLY from verified
 * JWT claims. `email` is the primary; an optional `custom:aliases` claim (comma-
 * separated) adds any aliases the admin assigned. Returns normalized addresses.
 */
function ownedAddresses(
  claims: Record<string, string | number | boolean | string[]>,
): string[] {
  const out = new Set<string>();
  const email = normalizeAddress(typeof claims.email === "string" ? claims.email : undefined);
  if (email) out.add(email);
  const aliases = claims["custom:aliases"];
  if (typeof aliases === "string") {
    for (const a of aliases.split(",")) {
      const n = normalizeAddress(a);
      if (n) out.add(n);
    }
  }
  return [...out];
}

/** Find a message by id across the caller's owned mailboxes, scoped via the JWT. */
async function findOwnedRow(
  messageId: string,
  owned: string[],
): Promise<Record<string, unknown> | undefined> {
  const ownedPks = new Set(owned.map(mailboxPk));
  const res = await ddb.send(
    new QueryCommand({
      TableName: INDEX_TABLE,
      IndexName: BY_MESSAGE_INDEX,
      KeyConditionExpression: "messageId = :m",
      ExpressionAttributeValues: { ":m": messageId },
    }),
  );
  // Defense in depth: even though the GSI returns rows for every recipient of
  // this messageId, only return one whose partition the caller actually owns.
  return (res.Items ?? []).find((it) => ownedPks.has(String(it.pk)));
}

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined;
}
function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---- Route handlers ---------------------------------------------------------

async function listMessages(
  owned: string[],
  query: Record<string, string | undefined>,
): Promise<APIGatewayProxyResultV2> {
  const folder = (query.folder ?? "inbox") as Folder;
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);

  // Common case: a single owned address → a single partition with a real cursor.
  if (owned.length === 1) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: INDEX_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :pfx)",
        ExpressionAttributeValues: { ":pk": mailboxPk(owned[0]!), ":pfx": folderPrefix(folder) },
        ScanIndexForward: false, // newest first
        Limit: limit,
        ExclusiveStartKey: decodeCursor(query.cursor),
      }),
    );
    return json(200, {
      items: (res.Items ?? []).map(toMeta),
      cursor: encodeCursor(res.LastEvaluatedKey as Record<string, unknown> | undefined),
    });
  }

  // Multiple owned addresses: query each partition, merge, sort, slice.
  const all: MessageMeta[] = [];
  for (const addr of owned) {
    const res = await ddb.send(
      new QueryCommand({
        TableName: INDEX_TABLE,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :pfx)",
        ExpressionAttributeValues: { ":pk": mailboxPk(addr), ":pfx": folderPrefix(folder) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    all.push(...(res.Items ?? []).map(toMeta));
  }
  all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return json(200, { items: all.slice(0, limit) });
}

// Storage usage for the signed-in mailbox: sum of sizeBytes across its rows,
// plus its quota (if set). Lets the client show "X% of Y used".
async function getUsage(owned: string[]): Promise<APIGatewayProxyResultV2> {
  const address = owned[0]!;
  let usedBytes = 0;
  let messageCount = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: INDEX_TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": mailboxPk(address) },
        ProjectionExpression: "sizeBytes",
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) {
      usedBytes += Number(item.sizeBytes ?? 0);
      messageCount += 1;
    }
    ExclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  let quotaBytes: number | null = null;
  if (SETTINGS_TABLE) {
    try {
      const q = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: quotaSettingsKey(address) } }));
      const v = q.Item?.quotaBytes;
      if (typeof v === "number" && v > 0) quotaBytes = v;
    } catch {
      /* usage is still useful without the quota */
    }
  }
  return json(200, { email: address, usedBytes, messageCount, quotaBytes });
}

// Lambda caps a synchronous response at 6 MB, and the body here is JSON-escaped on
// top of that. A message with a large attachment (a 6 MB PDF is ~8 MB once base64'd
// into MIME, more once sealed) blew straight through it — API Gateway then answered
// a bare 500 "Internal Server Error", so a perfectly good message looked broken.
// Above the threshold we hand back a presigned S3 URL and let the client stream the
// bytes directly; encrypted mail is unaffected either way since the client decrypts
// (the Lambda only ever sees ciphertext and could not strip attachments itself).
const INLINE_EML_LIMIT = 4 * 1024 * 1024;

async function getRaw(messageId: string, owned: string[]): Promise<APIGatewayProxyResultV2> {
  const row = await findOwnedRow(messageId, owned);
  if (!row) return json(404, { error: "not found" });
  const key = String(row.s3Key);
  const meta = {
    encrypted: row.encrypted === true,
    encWrappedKey: typeof row.encWrappedKey === "string" ? row.encWrappedKey : undefined,
  };

  const head = await s3.send(new HeadObjectCommand({ Bucket: MAIL_BUCKET, Key: key })).catch(() => null);
  if ((head?.ContentLength ?? 0) > INLINE_EML_LIMIT) {
    const emlUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: MAIL_BUCKET, Key: key }), {
      expiresIn: 300,
    });
    // `eml` is deliberately omitted: a client that doesn't understand `emlUrl` gets a
    // clear, actionable message instead of a mystery parse failure or a 500.
    return json(200, {
      ...meta,
      emlUrl,
      sizeBytes: head?.ContentLength,
      error:
        "This message is too large to open in this version of the app. Update to the latest version to read it.",
    });
  }

  const obj = await s3.send(
    new GetObjectCommand({ Bucket: MAIL_BUCKET, Key: key }),
  );
  const eml = await obj.Body!.transformToString();
  // Return the encryption meta WITH the bytes so a client opening this message from
  // a push notification (which can't carry the wrapped key) never has to scan the
  // inbox list to learn whether the body is sealed — the scan can miss on a stale or
  // paginated list and then the client would try to parse ciphertext as plaintext.
  // `encrypted` is ALWAYS a boolean here (never omitted) so a client can distinguish
  // "clear mail" (false) from "an old backend that doesn't send meta" (field absent).
  return json(200, {
    eml,
    encrypted: row.encrypted === true,
    encWrappedKey: typeof row.encWrappedKey === "string" ? row.encWrappedKey : undefined,
  });
}

async function getAttachment(
  messageId: string,
  indexStr: string,
  owned: string[],
): Promise<APIGatewayProxyResultV2> {
  const row = await findOwnedRow(messageId, owned);
  if (!row) return json(404, { error: "not found" });
  const attachments = (row.attachments ?? []) as AttachmentMeta[];
  const index = Number(indexStr);
  const att = Number.isInteger(index) && index >= 0 ? attachments[index] : undefined;
  if (!att?.s3Key) return json(404, { error: "attachment not found" });

  // Block downloads GuardDuty Malware Protection flagged as malware. This is a
  // no-op when malware scanning is disabled (objects then have no scan tag) and
  // fail-open on a tag-read error so a transient glitch can't hide clean mail.
  try {
    const tagging = await s3.send(new GetObjectTaggingCommand({ Bucket: MAIL_BUCKET, Key: att.s3Key }));
    const scan = tagging.TagSet?.find((t) => t.Key === "GuardDutyMalwareScanStatus")?.Value;
    if (scan === "THREATS_FOUND") {
      return json(403, { error: "This attachment was flagged as malware by the scanner and can't be downloaded." });
    }
  } catch {
    /* best-effort: don't block a legitimate download on a tagging read error */
  }

  // Hand back a short-lived presigned S3 URL — the client downloads directly
  // from S3 (avoids streaming large files through API Gateway / Lambda).
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: MAIL_BUCKET,
      Key: att.s3Key,
      ResponseContentDisposition: `attachment; filename="${att.filename.replace(/"/g, "")}"`,
      ResponseContentType: att.contentType,
    }),
    { expiresIn: 300 },
  );
  return json(200, { url, filename: att.filename, contentType: att.contentType });
}

async function setFlags(
  messageId: string,
  owned: string[],
  body: Partial<MessageFlags>,
): Promise<APIGatewayProxyResultV2> {
  const row = await findOwnedRow(messageId, owned);
  if (!row) return json(404, { error: "not found" });
  const current = (row.flags ?? {}) as MessageFlags;
  const next: MessageFlags = { ...current, ...body };
  const res = await ddb.send(
    new UpdateCommand({
      TableName: INDEX_TABLE,
      Key: { pk: row.pk, sk: row.sk },
      UpdateExpression: "SET flags = :f",
      ExpressionAttributeValues: { ":f": next },
      ReturnValues: "ALL_NEW",
    }),
  );
  return json(200, toMeta(res.Attributes ?? {}));
}

async function moveMessage(
  messageId: string,
  owned: string[],
  toFolder: Folder,
): Promise<APIGatewayProxyResultV2> {
  const row = await findOwnedRow(messageId, owned);
  if (!row) return json(404, { error: "not found" });
  const meta = toMeta(row);
  if (meta.folder === toFolder) return json(200, meta);

  // The folder lives in the sort key, so a move = delete old row + put new row.
  const newItem = { ...row, folder: toFolder, sk: messageSk(toFolder, meta.date, messageId) };
  await ddb.send(new PutCommand({ TableName: INDEX_TABLE, Item: newItem }));
  await ddb.send(new DeleteCommand({ TableName: INDEX_TABLE, Key: { pk: row.pk, sk: row.sk } }));
  return json(200, toMeta(newItem));
}

/**
 * Permanently empty the Trash folder for every mailbox the caller owns. This is
 * the user-driven counterpart to the janitor's scheduled purge: each trashed
 * message's raw S3 object and its index row are hard-deleted. Irreversible, and
 * scoped to "trash" only — nothing in other folders is touched.
 */
async function emptyTrash(owned: string[]): Promise<APIGatewayProxyResultV2> {
  let deleted = 0;
  for (const address of owned) {
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const out = await ddb.send(
        new QueryCommand({
          TableName: INDEX_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :pfx)",
          ExpressionAttributeValues: { ":pk": mailboxPk(address), ":pfx": folderPrefix("trash") },
          ProjectionExpression: "pk, sk, s3Key",
          ExclusiveStartKey,
        }),
      );
      for (const item of out.Items ?? []) {
        const s3Key = item.s3Key ? String(item.s3Key) : "";
        if (s3Key) {
          await s3
            .send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: s3Key }))
            .catch((e) => console.error("s3 delete failed", s3Key, e));
        }
        await ddb.send(new DeleteCommand({ TableName: INDEX_TABLE, Key: { pk: item.pk, sk: item.sk } }));
        deleted += 1;
      }
      ExclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (ExclusiveStartKey);
  }
  return json(200, { ok: true, deleted });
}

interface SendAttachmentInput {
  filename: string;
  contentType: string;
  /** Inline base64 bytes (small files) — or set s3Key for the staged-upload path. */
  contentBase64?: string;
  /** Staging key from POST /attachments/presign (large files uploaded to S3). */
  s3Key?: string;
}
interface PresignBody {
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}
interface SendBody {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  html?: string;
  text?: string;
  from?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: SendAttachmentInput[];
  /** When the send originates from a saved draft, its id — removed after send. */
  draftId?: string;
}

interface DraftBody {
  draftId?: string;
  to?: string[];
  subject?: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
}

async function sendMessage(owned: string[], body: SendBody): Promise<APIGatewayProxyResultV2> {
  const to = (body.to ?? []).map(normalizeAddress).filter(Boolean);
  const cc = (body.cc ?? []).map(normalizeAddress).filter(Boolean);
  const bcc = (body.bcc ?? []).map(normalizeAddress).filter(Boolean);
  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    return json(400, { error: "at least one recipient required" });
  }

  // The From address must be one the caller owns. A requested From the session
  // does NOT own is REJECTED — never silently replaced with another identity —
  // so a client whose session got crossed with a different mailbox can't send
  // mail misattributed to that mailbox (field bug 2026-07-29: a compose "as" one
  // account went out as another). Only a request with NO from at all falls back
  // to the session's primary address (older clients don't send from). Decision
  // logic lives in core (`resolveSenderAddress`), unit-tested.
  const requested = normalizeAddress(body.from);
  const sender = resolveSenderAddress(requested || undefined, owned);
  if (!sender.ok) {
    if (sender.reason === "not-owned") {
      console.warn(`send: rejected From mismatch — requested ${requested}, session owns [${owned.join(", ")}]`);
      return json(403, {
        error: `this sign-in can't send as ${requested} — remove and re-add that mailbox, then try again`,
      });
    }
    return json(403, { error: "no sending identity" });
  }
  const from = sender.from;

  // SES delivery destination. Cc is also rendered as a header (visible); Bcc is
  // delivery-only and never written into the message headers, so To/Cc recipients
  // can't see the bcc list.
  const destination = {
    ToAddresses: to,
    ...(cc.length ? { CcAddresses: cc } : {}),
    ...(bcc.length ? { BccAddresses: bcc } : {}),
  };

  const subject = body.subject ?? "(no subject)";
  const text = body.text ?? "";
  const html = body.html;

  // Gather attachment bytes (shared between the SES send and the Sent-copy store).
  // Two paths: small files arrive inline as base64; large files were uploaded
  // straight to S3 (presigned PUT) and arrive as a staging key we fetch here.
  // Harden the content type server-side too: a generic/empty type makes Gmail and
  // others refuse to open the file ("Unsupported file type"), so infer it from
  // the filename extension when the client didn't send a specific one.
  const inputAttachments = body.attachments ?? [];
  const ownerSeg = stagingOwnerSegment(owned);
  // Never trust a client-supplied key: only accept staged objects under this
  // caller's own prefix.
  for (const a of inputAttachments) {
    if (a.s3Key && !String(a.s3Key).startsWith(`${STAGING_PREFIX}${ownerSeg}/`)) {
      return json(403, { error: "attachment not authorized" });
    }
  }
  const stagedKeys: string[] = [];
  let decoded: { filename: string; contentType: string; bytes: Buffer }[];
  try {
    decoded = await Promise.all(
      inputAttachments.map(async (a) => {
        const filename = a.filename || "attachment";
        const contentType = resolveContentType(a.contentType, filename);
        if (a.s3Key) {
          const key = String(a.s3Key);
          const obj = await s3.send(new GetObjectCommand({ Bucket: MAIL_BUCKET, Key: key }));
          const bytes = Buffer.from(await obj.Body!.transformToByteArray());
          stagedKeys.push(key);
          return { filename, contentType, bytes };
        }
        return { filename, contentType, bytes: Buffer.from(a.contentBase64 ?? "", "base64") };
      }),
    );
  } catch (e) {
    console.error("send: staged attachment fetch failed", e);
    return json(400, { error: "a staged attachment couldn't be read — please re-attach and try again" });
  }

  const attachmentBytes = decoded.reduce((n, a) => n + a.bytes.length, 0);
  // Enforce the admin-configured cap as well as SES's hard 40 MB ceiling.
  const sendSettings = await loadSendSettings();
  if (attachmentBytes > sendSettings.maxAttachmentBytes) {
    return json(413, { error: `attachments exceed the ${formatBytes(sendSettings.maxAttachmentBytes)} limit` });
  }
  const approxBytes = Buffer.byteLength(subject + text + (html ?? ""), "utf8") + attachmentBytes;
  if (approxBytes > SES_MAX_MESSAGE_BYTES) {
    return json(413, { error: "message exceeds the 40MB SES limit" });
  }

  const date = new Date().toISOString();
  // Our own RFC Message-ID for the message body; SES returns its own id which we
  // use for storage keys.
  const headerMessageId = `${Date.now()}.${Math.random().toString(36).slice(2)}@${from.slice(from.lastIndexOf("@") + 1)}`;

  let messageId: string;
  let rawEml: string;
  if (decoded.length > 0) {
    // Attachments → build a proper multipart/mixed MIME message and send it raw.
    // The SESv2 "Simple" + Attachments path produced messages Gmail refused to
    // open; a hand-built raw message is universally compatible. We also store this
    // exact raw as the Sent copy so the Sent folder shows the attachment.
    rawEml = buildMimeMessage({
      from,
      to,
      cc,
      subject,
      text,
      html,
      messageId: headerMessageId,
      date,
      inReplyTo: body.inReplyTo,
      references: body.references,
      attachments: decoded.map((a) => ({ filename: a.filename, contentType: a.contentType, bytes: a.bytes })),
    });
    const sent = await sesSend(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: destination,
        Content: { Raw: { Data: Buffer.from(rawEml, "utf8") } },
      }),
    );
    messageId = sent.MessageId ?? `local-${Date.now()}`;
  } else {
    // No attachments → the simple content type is fine (and proven).
    const headers: MessageHeader[] = [];
    if (body.inReplyTo) headers.push({ Name: "In-Reply-To", Value: body.inReplyTo });
    if (body.references) headers.push({ Name: "References", Value: body.references });
    const sent = await sesSend(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: destination,
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}),
              ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
            },
            ...(headers.length ? { Headers: headers } : {}),
          },
        },
      }),
    );
    messageId = sent.MessageId ?? `local-${Date.now()}`;
    rawEml = buildRawEml({ from, to, cc, subject, text, html, messageId, date, inReplyTo: body.inReplyTo });
  }

  // Store each attachment to S3 so the Sent copy's attachments are downloadable
  // via the same GET /messages/{id}/attachments/{index} endpoint.
  const sentAttachments: AttachmentMeta[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const a = decoded[i]!;
    const key = attachmentS3Key(messageId, i, a.filename);
    await s3.send(
      new PutObjectCommand({ Bucket: MAIL_BUCKET, Key: key, Body: a.bytes, ContentType: a.contentType }),
    );
    sentAttachments.push({ filename: a.filename, contentType: a.contentType, sizeBytes: a.bytes.length, s3Key: key });
  }

  // Store the Sent copy (.eml) + an index row so the Sent folder is readable.
  const s3Key = `${SENT_PREFIX}${messageId}`;
  await s3.send(
    new PutObjectCommand({ Bucket: MAIL_BUCKET, Key: s3Key, Body: rawEml, ContentType: "message/rfc822" }),
  );

  const meta: MessageMeta = {
    domain: from.slice(from.lastIndexOf("@") + 1),
    mailbox: from,
    messageId,
    threadId: body.references?.split(/\s+/)[0]?.replace(/^<|>$/g, "") || messageId,
    folder: "sent",
    from: { address: from },
    to: to.map((address) => ({ address })),
    subject,
    snippet: (text || html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140),
    date,
    flags: { unread: false },
    hasAttachments: sentAttachments.length > 0,
    attachments: sentAttachments.length > 0 ? sentAttachments : undefined,
    s3Key,
    sizeBytes: Buffer.byteLength(rawEml, "utf8") + attachmentBytes,
  };
  await ddb.send(
    new PutCommand({
      TableName: INDEX_TABLE,
      Item: { pk: mailboxPk(from), sk: messageSk("sent", date, messageId), ...meta },
    }),
  );

  // If this send originated from a saved draft, remove it now that the mail has
  // gone out (best-effort: the email already shipped, so a cleanup hiccup must
  // not fail the request — the draft just lingers until re-saved/deleted).
  if (body.draftId) {
    try {
      await removeDraft(body.draftId, owned);
    } catch (err) {
      console.error("draft cleanup after send failed", body.draftId, err);
    }
  }

  // Drop the staged uploads now they've been copied into the Sent attachments.
  // Best-effort — the bucket lifecycle rule is the backstop if any delete fails.
  if (stagedKeys.length > 0) {
    await Promise.allSettled(
      stagedKeys.map((key) => s3.send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: key }))),
    );
  }

  return json(200, { messageId });
}

// ---- Outbound config + large-attachment staging -----------------------------

/** Expose the deployment's send limits so clients show the right cap up front. */
async function getSendConfig(): Promise<APIGatewayProxyResultV2> {
  const settings = await loadSendSettings();
  return json(200, { maxAttachmentBytes: settings.maxAttachmentBytes });
}

/**
 * Reserve an S3 staging slot for a large attachment and hand back a short-lived
 * presigned PUT URL. The size is validated against the admin-set cap here so the
 * client is told "too large" before it uploads a single byte. The key is scoped
 * to the caller (stagingOwnerSegment) so /send can prove ownership later.
 */
async function presignUpload(owned: string[], body: PresignBody): Promise<APIGatewayProxyResultV2> {
  const size = Number(body.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) {
    return json(400, { error: "missing or invalid sizeBytes" });
  }
  const settings = await loadSendSettings();
  if (size > settings.maxAttachmentBytes) {
    return json(413, { error: `attachment exceeds the ${formatBytes(settings.maxAttachmentBytes)} limit` });
  }
  const filename = (body.filename || "attachment").replace(/[^\w.\-]+/g, "_").slice(0, 200);
  const key = `${STAGING_PREFIX}${stagingOwnerSegment(owned)}/${randomUUID()}/${filename}`;
  // Sign only the bucket + key — not the content-type — so the client can PUT the
  // bytes with whatever (or no) content-type header without a signature mismatch.
  // /send rebuilds the MIME with its own resolved content-type regardless.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: MAIL_BUCKET, Key: key }),
    { expiresIn: 300 },
  );
  return json(200, { uploadUrl, key });
}

// ---- Drafts -----------------------------------------------------------------

/**
 * Save (or update) a draft. Drafts are stored exactly like any other message —
 * a `.eml` in S3 + an index row in the "drafts" folder — so they list, read and
 * send through the same paths. Re-saving with the same `draftId` overwrites in
 * place (no duplicate). Ownership is the caller's primary address from the JWT.
 */
async function saveDraft(owned: string[], body: DraftBody): Promise<APIGatewayProxyResultV2> {
  const mailbox = owned[0]!;
  const domain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
  const to = (body.to ?? []).map(normalizeAddress).filter(Boolean);
  const subject = body.subject ?? "";
  const text = body.text ?? "";
  const html = body.html;
  const date = new Date().toISOString();

  // Reuse the id on re-save so editing updates the same draft; mint one on first
  // save. The id is bound to the caller's own domain.
  const draftId =
    typeof body.draftId === "string" && body.draftId.trim()
      ? body.draftId.trim()
      : `draft-${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}`;

  const rawEml = buildRawEml({
    from: mailbox,
    to,
    subject,
    text,
    html,
    messageId: draftId,
    date,
    inReplyTo: body.inReplyTo,
    references: body.references,
  });
  const s3Key = `${DRAFTS_PREFIX}${draftId}`;
  await s3.send(
    new PutObjectCommand({ Bucket: MAIL_BUCKET, Key: s3Key, Body: rawEml, ContentType: "message/rfc822" }),
  );

  // A re-save uses a fresh date → a new sort key, so drop the previous row first
  // (the S3 object overwrites in place under the stable key).
  const existing = await findOwnedRow(draftId, owned);
  if (existing) {
    await ddb.send(new DeleteCommand({ TableName: INDEX_TABLE, Key: { pk: existing.pk, sk: existing.sk } }));
  }

  const meta: MessageMeta = {
    domain,
    mailbox,
    messageId: draftId,
    threadId: body.references?.split(/\s+/)[0]?.replace(/^<|>$/g, "") || draftId,
    folder: "drafts",
    from: { address: mailbox },
    to: to.map((address) => ({ address })),
    subject,
    snippet: (text || html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140),
    date,
    flags: { unread: false },
    hasAttachments: false,
    s3Key,
    sizeBytes: Buffer.byteLength(rawEml, "utf8"),
  };
  await ddb.send(
    new PutCommand({
      TableName: INDEX_TABLE,
      Item: { pk: mailboxPk(mailbox), sk: messageSk("drafts", date, draftId), ...meta },
    }),
  );
  return json(200, { draftId, ...meta });
}

/** Hard-delete a draft (S3 object + index row). Only ever touches "drafts". */
async function removeDraft(draftId: string, owned: string[]): Promise<boolean> {
  const row = await findOwnedRow(draftId, owned);
  if (!row || row.folder !== "drafts") return false;
  await s3.send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: String(row.s3Key) }));
  await ddb.send(new DeleteCommand({ TableName: INDEX_TABLE, Key: { pk: row.pk, sk: row.sk } }));
  return true;
}

async function deleteDraft(draftId: string, owned: string[]): Promise<APIGatewayProxyResultV2> {
  const removed = await removeDraft(draftId, owned);
  return removed ? json(200, { ok: true }) : json(404, { error: "draft not found" });
}

function buildRawEml(m: {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  date: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    // Cc is visible; Bcc is never written to the stored/sent message headers.
    ...(m.cc && m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${m.subject}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: ${m.html ? "text/html" : "text/plain"}; charset=utf-8`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n${m.html ?? m.text}`;
}

// ---- Mobile push device tokens ---------------------------------------------
// A mailbox's registered Expo push tokens live in SETTINGS under
// `devices#<address>`. We store the SAME registry under every address the caller
// owns (primary + aliases) so the inbound-processor — which looks up tokens by
// the exact recipient address — finds them no matter which alias received mail.

async function loadDeviceRegistry(address: string): Promise<DeviceRegistry> {
  const out = await ddb.send(
    new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: devicesSettingsKey(address) } }),
  );
  const raw = out.Item?.json;
  if (typeof raw !== "string") return { tokens: [] };
  try {
    return pruneDeviceTokens(JSON.parse(raw) as DeviceRegistry);
  } catch {
    return { tokens: [] };
  }
}

async function saveDeviceRegistry(address: string, reg: DeviceRegistry): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: { pk: devicesSettingsKey(address), json: JSON.stringify(reg) },
    }),
  );
}

interface DeviceBody {
  token?: string;
  platform?: string;
}

/** Register / refresh the caller's device for new-mail push notifications. */
async function registerDevice(owned: string[], body: DeviceBody): Promise<APIGatewayProxyResultV2> {
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!isExpoPushToken(token)) return json(400, { error: "invalid push token" });
  const platform = body.platform === "android" ? "android" : "ios";
  for (const address of owned) {
    const reg = await loadDeviceRegistry(address);
    await saveDeviceRegistry(address, addDeviceToken(reg, token, platform));
  }
  return json(200, { ok: true });
}

/** Unregister a device token (sign-out, or the app detects it's stale). */
async function unregisterDevice(owned: string[], token: string): Promise<APIGatewayProxyResultV2> {
  const t = token.trim();
  if (!t) return json(400, { error: "missing token" });
  for (const address of owned) {
    const reg = await loadDeviceRegistry(address);
    await saveDeviceRegistry(address, removeDeviceToken(reg, t));
  }
  return json(200, { ok: true });
}

// ---- Mailbox encryption keys -----------------------------------------------
// A mailbox's public key + password-wrapped private key live in SETTINGS under
// `keys#<address>`. The admin can read this and STILL can't read mail: the wrapped
// private key is useless without the user's password, and the public key only lets
// senders encrypt *to* the mailbox. Stored under every owned address (primary +
// aliases) so the inbound-processor finds the public key for whichever alias got mail.

async function loadMailboxKeyRecord(address: string): Promise<MailboxKeyRecord | null> {
  const out = await ddb.send(
    new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: mailboxKeysKey(address) } }),
  );
  const raw = out.Item?.json;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return isMailboxKeyRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The caller's own key record. `record: null` tells the client to generate a
 *  keypair on this login (first-login keygen) and PUT it back. */
async function getMailboxKeys(owned: string[]): Promise<APIGatewayProxyResultV2> {
  if (!SETTINGS_TABLE) return json(200, { record: null });
  return json(200, { record: await loadMailboxKeyRecord(owned[0]!) });
}

/** Upload the caller's key record (first-login keygen, or re-wrap on password change).
 *  Written under every owned address. Scoped to the JWT — a caller can only set its own. */
async function putMailboxKeys(owned: string[], body: unknown): Promise<APIGatewayProxyResultV2> {
  if (!SETTINGS_TABLE) return json(500, { error: "settings table not configured" });
  if (!isMailboxKeyRecord(body)) return json(400, { error: "invalid key record" });
  for (const address of owned) {
    await ddb.send(
      new PutCommand({
        TableName: SETTINGS_TABLE,
        Item: { pk: mailboxKeysKey(address), json: JSON.stringify(body) },
      }),
    );
  }
  return json(200, { ok: true });
}

// ---- Dispatcher -------------------------------------------------------------

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const owned = ownedAddresses(event.requestContext.authorizer.jwt.claims);
  if (owned.length === 0) return json(401, { error: "no mailbox identity in token" });

  const route = event.routeKey; // e.g. "GET /messages/{id}/raw"
  const id = event.pathParameters?.id ? decodeURIComponent(event.pathParameters.id) : undefined;
  const query = (event.queryStringParameters ?? {}) as Record<string, string | undefined>;
  const parseBody = <T,>(): T => {
    if (!event.body) return {} as T;
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  };

  try {
    switch (route) {
      case "GET /usage":
        return await getUsage(owned);
      case "GET /messages":
        return await listMessages(owned, query);
      case "GET /messages/{id}/raw":
        return id ? await getRaw(id, owned) : json(400, { error: "missing id" });
      case "GET /messages/{id}/attachments/{index}": {
        const index = event.pathParameters?.index;
        if (!id || index === undefined) return json(400, { error: "missing id/index" });
        return await getAttachment(id, index, owned);
      }
      case "PATCH /messages/{id}/flags":
        return id ? await setFlags(id, owned, parseBody<Partial<MessageFlags>>()) : json(400, { error: "missing id" });
      case "POST /messages/{id}/move": {
        const b = parseBody<{ folder?: Folder }>();
        if (!id) return json(400, { error: "missing id" });
        if (!b.folder) return json(400, { error: "missing folder" });
        return await moveMessage(id, owned, b.folder);
      }
      case "POST /trash/empty":
        return await emptyTrash(owned);
      case "POST /send":
        return await sendMessage(owned, parseBody<SendBody>());
      case "GET /send-config":
        return await getSendConfig();
      case "POST /attachments/presign":
        return await presignUpload(owned, parseBody<PresignBody>());
      case "POST /drafts":
        return await saveDraft(owned, parseBody<DraftBody>());
      case "DELETE /drafts/{id}":
        return id ? await deleteDraft(id, owned) : json(400, { error: "missing id" });
      case "POST /devices":
        return await registerDevice(owned, parseBody<DeviceBody>());
      case "DELETE /devices/{token}": {
        const token = event.pathParameters?.token ? decodeURIComponent(event.pathParameters.token) : "";
        return await unregisterDevice(owned, token);
      }
      case "GET /mailbox-keys":
        return await getMailboxKeys(owned);
      case "PUT /mailbox-keys":
        return await putMailboxKeys(owned, parseBody<unknown>());
      default:
        return json(404, { error: `no route for ${route}` });
    }
  } catch (err) {
    // A user-fixable send rejection is not a server error: return the explanation
    // itself. friendlyApiMessage() renders body.error verbatim for 403, so every
    // client (desktop, mobile, webmail) shows it without a client-side change.
    if (err instanceof SendRejected) return json(403, { error: err.message });
    console.error("access-api error", route, err);
    return json(500, { error: "internal error" });
  }
}
