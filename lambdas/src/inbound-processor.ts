import type { SESEvent, SESReceipt } from "aws-lambda";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { simpleParser, type AddressObject, type Attachment } from "mailparser";
import { gunzipSync, unzipSync, strFromU8 } from "fflate";
import {
  type MessageMeta,
  type AuthVerdicts,
  type EmailAddress,
  type AttachmentMeta,
  type DeploymentPolicy,
  type SpamPolicy,
  type DmarcAttachmentKind,
  DEFAULT_POLICY,
  mailboxPk,
  folderPrefix,
  messageSk,
  deriveThreadId,
  mapVerdict,
  classifyDelivery,
  normalizeAddress,
  addressDomain,
  attachmentS3Key,
  resolveContentType,
  quotaSettingsKey,
  wouldExceedQuota,
  policySettingsKey,
  normalizeSpamPolicy,
  isKnownMailbox,
  parseDmarcAggregate,
  summarizeAggregate,
  dmarcAttachmentKind,
  devicesSettingsKey,
  buildExpoPushMessages,
  removeDeviceTokens,
  pruneDeviceTokens,
  type DeviceRegistry,
  mailboxKeysKey,
  isMailboxKeyRecord,
  agentOwnedSettingsKey,
  buildAgentMailPayload,
  CREWPOPPY_RUNNER_FUNCTION,
  type AgentMailPayload,
  generateContentKey,
  encryptWithContentKey,
  wrapContentKey,
  buildReadingEml,
  canStripForReadingCopy,
  type Sodium,
} from "@mailpoppy/core";
import _sodium from "libsodium-wrappers-sumo";

// Mailbox encryption (docs/mailbox-encryption-design.md). When a recipient is
// activated (has a public key), seal the body + attachments to it before storing
// so the at-rest copy is unreadable without the user's password. One libsodium
// instance, ready once per cold start.
const sodiumReady: Promise<Sodium> = _sodium.ready.then(() => _sodium as unknown as Sodium);

/**
 * Triggered by an SES receipt rule (Lambda action) AFTER the S3 action has
 * written the raw .eml to the mail bucket under `inbound/<messageId>`. This is
 * where raw S3 objects become an inbox: we read SES's verdicts + recipients from
 * the event, parse the MIME body for display metadata, apply the spam/auth
 * policy, and write one "mailbox state" row per local recipient to DynamoDB.
 * See DESIGN §8 / §9.1.
 */
const s3 = new S3Client({});
const ses = new SESv2Client({});
const cognito = new CognitoIdentityProviderClient({});
const lambdaClient = new LambdaClient({});
// removeUndefinedValues: optional MessageMeta fields (from.name, attachments, …)
// are often undefined; without this the DocumentClient throws on marshalling.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const INDEX_TABLE = process.env.INDEX_TABLE ?? "";
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";
const MAIL_BUCKET = process.env.MAIL_BUCKET ?? "";
const USER_POOL_ID = process.env.USER_POOL_ID ?? "";
const INBOUND_PREFIX = process.env.INBOUND_PREFIX ?? "inbound/";
/**
 * Master switch for at-rest mailbox encryption. OFF by default so this code is
 * inert until every client can DECRYPT (Phase 5) — flipping it on before then
 * would store ciphertext that current clients render as garbage. Set to "true"
 * on the inbound Lambda's environment to enable (the design's "flip on" step).
 */
const ENCRYPTION_ENABLED = (process.env.ENCRYPTION_ENABLED ?? "").toLowerCase() === "true";
/**
 * Fallback allowlist of hosted domains, used ONLY when the live Cognito mailbox
 * lookup fails (so we don't drop mail on a transient blip). In normal operation
 * the mailbox set is authoritative and spans every provisioned domain. Empty =
 * accept all recipients the catch-all receipt rule delivered.
 */
const HOSTED_DOMAINS = (process.env.HOSTED_DOMAINS ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

function verdictsFrom(receipt: SESReceipt): AuthVerdicts {
  return {
    spam: mapVerdict(receipt.spamVerdict?.status),
    virus: mapVerdict(receipt.virusVerdict?.status),
    spf: mapVerdict(receipt.spfVerdict?.status),
    dkim: mapVerdict(receipt.dkimVerdict?.status),
    dmarc: mapVerdict(receipt.dmarcVerdict?.status),
  };
}

function firstFrom(parsedFrom: AddressObject | AddressObject[] | undefined): EmailAddress {
  const obj = Array.isArray(parsedFrom) ? parsedFrom[0] : parsedFrom;
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

function isHosted(recipient: string): boolean {
  if (HOSTED_DOMAINS.length === 0) return true;
  return HOSTED_DOMAINS.includes(addressDomain(recipient));
}

/**
 * Load the admin's spam/auth policy (allow/block lists + per-verdict actions)
 * for a given scope (a recipient domain, or "default" for the deployment-wide
 * policy). Returns null if there's no doc for that scope. Fail-safe: any
 * malformed doc or read error is treated as "no doc" so the caller can fall back.
 */
async function loadSpamPolicyScoped(scope: string): Promise<SpamPolicy | null> {
  if (!SETTINGS_TABLE) return null;
  try {
    const out = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: policySettingsKey(scope) } }));
    const json = out.Item?.json;
    if (typeof json !== "string") return null;
    return normalizeSpamPolicy(JSON.parse(json) as Partial<SpamPolicy>);
  } catch {
    return null;
  }
}

/**
 * The recipient mailbox's public key (base64), or null when the mailbox isn't
 * activated yet (no keypair until the user first logs in) or the lookup fails.
 * Null ⇒ store this message in clear (accepted pre-activation window, §10);
 * non-null ⇒ seal the body + attachments to it. Fail-safe: a read error never
 * blocks delivery, it just falls back to storing plaintext.
 */
async function loadMailboxPubKey(address: string): Promise<string | null> {
  if (!SETTINGS_TABLE) return null;
  try {
    const out = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: mailboxKeysKey(address) } }));
    const raw = out.Item?.json;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    return isMailboxKeyRecord(parsed) ? parsed.publicKey : null;
  } catch {
    return null;
  }
}

/** A mailbox's storage quota in bytes, or null if none is set. */
async function quotaFor(address: string): Promise<number | null> {
  if (!SETTINGS_TABLE) return null;
  try {
    const out = await ddb.send(new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: quotaSettingsKey(address) } }));
    const v = out.Item?.quotaBytes;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null; // never block delivery on a settings read error
  }
}

/** Current storage used by a mailbox = sum of sizeBytes across its rows. */
async function mailboxUsage(pk: string): Promise<number> {
  let used = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: INDEX_TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "sizeBytes",
        ExclusiveStartKey,
      }),
    );
    for (const item of out.Items ?? []) used += Number(item.sizeBytes ?? 0);
    ExclusiveStartKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return used;
}

/** A bounce shouldn't itself trigger a bounce — skip system/empty senders. */
function isSystemSender(address: string): boolean {
  if (!address) return true;
  const local = address.split("@")[0] ?? "";
  return /^(mailer-daemon|postmaster|no-?reply|bounce|abuse)$/i.test(local);
}

/** Notify the original sender that the mailbox is full (a simple NDR). */
async function sendQuotaBounce(recipient: string, sender: string, subject: string): Promise<void> {
  if (isSystemSender(sender)) return;
  const from = `mailer-daemon@${addressDomain(recipient)}`;
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [sender] },
        Content: {
          Simple: {
            Subject: { Data: `Undeliverable: ${subject}`, Charset: "UTF-8" },
            Body: {
              Text: {
                Data: `Your message to ${recipient} could not be delivered because the mailbox is full and has reached its storage limit. Please try again later, or contact the recipient by another means.`,
                Charset: "UTF-8",
              },
            },
          },
        },
      }),
    );
  } catch (e) {
    console.error(`failed to send quota bounce to ${sender}:`, e);
  }
}

// Cache the mailbox set briefly across warm invocations (a freshly-created
// mailbox becomes deliverable within this TTL).
let mailboxCache: { at: number; set: Set<string> } | null = null;
const MAILBOX_TTL_MS = 60_000;

/** The set of real mailbox addresses (Cognito users). Empty set if it can't be read. */
async function loadMailboxAddresses(): Promise<Set<string>> {
  if (!USER_POOL_ID) return new Set();
  if (mailboxCache && Date.now() - mailboxCache.at < MAILBOX_TTL_MS) return mailboxCache.set;
  const set = new Set<string>();
  try {
    let PaginationToken: string | undefined;
    do {
      const out = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken }));
      for (const u of out.Users ?? []) {
        const email = u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username;
        if (email) set.add(normalizeAddress(email));
      }
      PaginationToken = out.PaginationToken;
    } while (PaginationToken);
    mailboxCache = { at: Date.now(), set };
  } catch (e) {
    console.error("failed to list mailboxes (treating none as known):", e);
  }
  return set;
}

/**
 * Only bounce to a sender we can trust (passed SPF, DKIM, or DMARC). Spam to
 * random addresses usually has a forged From; bouncing it would send backscatter
 * to an innocent third party and harm our domain's reputation, so we drop it
 * silently instead.
 */
function senderAuthenticated(v: AuthVerdicts): boolean {
  return v.spf === "PASS" || v.dkim === "PASS" || v.dmarc === "PASS";
}

/** Notify the sender that the recipient address doesn't exist (a simple NDR). */
async function sendUnknownRecipientBounce(recipient: string, sender: string, subject: string): Promise<void> {
  if (isSystemSender(sender)) return;
  const from = `mailer-daemon@${addressDomain(recipient)}`;
  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [sender] },
        Content: {
          Simple: {
            Subject: { Data: `Undeliverable: ${subject}`, Charset: "UTF-8" },
            Body: {
              Text: {
                Data: `Your message to ${recipient} could not be delivered because that mailbox does not exist. Please check the address and try again.`,
                Charset: "UTF-8",
              },
            },
          },
        },
      }),
    );
  } catch (e) {
    console.error(`failed to send unknown-recipient bounce to ${sender}:`, e);
  }
}

// ---- DMARC aggregate-report ingestion --------------------------------------
// The role addresses our published `rua=` may point at. We absorb report mail
// to any of these (postmaster@ is what provisioning publishes today).
const DMARC_ROLE_LOCALPARTS = new Set(["postmaster", "dmarc", "dmarc-reports", "dmarcreports"]);

/** A hosted role address that DMARC aggregate reports are sent to. */
function isDmarcRoleRecipient(addr: string): boolean {
  const local = addr.split("@")[0] ?? "";
  return DMARC_ROLE_LOCALPARTS.has(local) && isHosted(addr);
}

/** True if any attachment looks like a (compressed) DMARC report file. */
function hasReportCandidate(attachments: Attachment[]): boolean {
  return attachments.some((a) => dmarcAttachmentKind(a.filename, a.contentType) !== null);
}

// Below this, stripping attachment bytes from the reading copy isn't worth the churn.
const READ_COPY_MIN_ATTACHMENT_BYTES = 128 * 1024;

function addressTexts(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).map((x) => x.text).filter(Boolean);
}

/**
 * A LIGHTWEIGHT reading copy of the raw .eml — body (text/html) intact, but each
 * attachment reduced to a zero-byte stub — so opening a message with a big attachment
 * doesn't force the client to download+decrypt+parse those megabytes just to show the
 * body (the attachment bytes live in their own S3 object, fetched on demand).
 *
 * Fail-safe by construction: returns the FULL raw eml unchanged whenever stripping
 * isn't provably safe — no attachments, any INLINE/cid image (those are body content
 * and must render), a small total payload (not worth it), or the rebuilt copy isn't
 * actually smaller. So reading can never regress; worst case it's the same as before.
 */
function readingCopyEml(raw: string, parsed: Awaited<ReturnType<typeof simpleParser>>, messageId: string): string {
  try {
    const atts = parsed.attachments ?? [];
    // Inline images are referenced from the HTML (cid:) — keep the whole message so
    // they still render; only strip a large, purely-real-attachment message. Gate is a
    // pure, unit-tested helper (canStripForReadingCopy).
    const strippable = canStripForReadingCopy(
      atts.map((a) => ({
        disposition: a.contentDisposition,
        cid: a.cid,
        related: a.related,
        sizeBytes: a.size ?? a.content?.length ?? 0,
      })),
      READ_COPY_MIN_ATTACHMENT_BYTES,
    );
    if (!strippable) return raw;
    const references = Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references ?? undefined;
    const built = buildReadingEml({
      from: parsed.from?.text ?? "",
      to: addressTexts(parsed.to),
      cc: addressTexts(parsed.cc),
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      html: parsed.html || undefined,
      // buildReadingEml re-wraps the id in <>; strip any existing brackets first.
      messageId: (parsed.messageId ?? "").replace(/^<|>$/g, "") || messageId,
      date: parsed.date ?? new Date(),
      inReplyTo: parsed.inReplyTo ?? undefined,
      references,
      // Match the stored-row fallback name (attachment-<i>) so the chip label and the
      // saved-file name agree for unnamed attachments; index alignment is unchanged.
      attachments: atts.map((a, i) => ({
        filename: a.filename ?? `attachment-${i}`,
        contentType: a.contentType ?? "application/octet-stream",
      })),
    });
    return built.length < raw.length ? built : raw;
  } catch (e) {
    console.warn(`readingCopyEml: keeping full raw for ${messageId}`, e);
    return raw;
  }
}

/** Decompress a report attachment to its XML text (gzip/zip/plain), or null. */
function decompressReportXml(kind: DmarcAttachmentKind, content: Buffer): string | null {
  try {
    if (kind === "xml") return content.toString("utf8");
    if (kind === "gzip") return strFromU8(gunzipSync(content));
    if (kind === "zip") {
      const files = unzipSync(content);
      const names = Object.keys(files);
      const xmlName = names.find((n) => n.toLowerCase().endsWith(".xml")) ?? names[0];
      return xmlName ? strFromU8(files[xmlName]!) : null;
    }
  } catch (e) {
    console.error("dmarc decompress failed", e);
  }
  return null;
}

/** Accumulate a domain's daily DMARC pass/fail counters (SETTINGS table). */
async function recordDmarcStats(
  domain: string,
  s: { volume: number; pass: number; fail: number },
): Promise<void> {
  if (!domain || !SETTINGS_TABLE || s.volume <= 0) return;
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await ddb.send(
    new UpdateCommand({
      TableName: SETTINGS_TABLE,
      Key: { pk: `DMARC#${domain}#${day}` },
      UpdateExpression:
        "SET #domain = if_not_exists(#domain, :domain), #day = if_not_exists(#day, :day) ADD #v :v, #p :p, #f :f, #r :one",
      ExpressionAttributeNames: { "#domain": "domain", "#day": "day", "#v": "volume", "#p": "pass", "#f": "fail", "#r": "reports" },
      ExpressionAttributeValues: { ":domain": domain, ":day": day, ":v": s.volume, ":p": s.pass, ":f": s.fail, ":one": 1 },
    }),
  );
}

/**
 * Parse + tally every DMARC report attachment on a message (best-effort).
 * Returns true if at least one real aggregate report was recognised — the caller
 * only absorbs the message when that's true, so a non-report message that merely
 * happens to carry a compressed attachment still falls through to normal mail
 * handling (never silently dropped).
 */
async function ingestDmarcReports(hintDomain: string | undefined, attachments: Attachment[]): Promise<boolean> {
  let ingested = false;
  for (const a of attachments) {
    const kind = dmarcAttachmentKind(a.filename, a.contentType);
    if (!kind) continue;
    const xml = decompressReportXml(kind, a.content);
    if (!xml) continue;
    const report = parseDmarcAggregate(xml);
    if (!report) continue;
    const domain = report.domain || hintDomain;
    if (!domain) continue;
    const summary = summarizeAggregate(report);
    await recordDmarcStats(domain, summary);
    ingested = true;
    console.log(
      `dmarc report: ${domain} vol=${summary.volume} pass=${summary.pass} fail=${summary.fail} (${report.orgName ?? "?"})`,
    );
  }
  return ingested;
}

// ---- CrewPoppy hand-off (agent-owned mailboxes) ------------------------------
// The MailPoppy ↔ CrewPoppy bridge (mailpoppy-bridge-spec.md v1): mail delivered
// to a mailbox the admin explicitly flagged agent-owned is COPIED to CrewPoppy's
// runner Lambda (fixed name, same account + region) so an email can start an
// agent run. The hand-off is a copy, not a detour — the mailbox row is already
// written before we get here, and NOTHING in this section may affect delivery:
// CrewPoppy absent, denied, or failing is one log line and move on.

/** Is this mailbox flagged agent-owned? Default (and any read failure) = OFF —
 *  a settings blip must never start an agent run. */
async function isAgentOwned(address: string): Promise<boolean> {
  if (!SETTINGS_TABLE) return false;
  try {
    const out = await ddb.send(
      new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: agentOwnedSettingsKey(address) } }),
    );
    return out.Item?.agentOwned === true;
  } catch {
    return false;
  }
}

/** Fire-and-forget invoke of CrewPoppyRunner. At most ONE retry (spec: no retry
 *  storms), and "function absent / not permitted" is expected — CrewPoppy simply
 *  isn't installed — so it logs and returns without retrying. */
async function handOffToAgent(payload: AgentMailPayload): Promise<void> {
  const invoke = () =>
    lambdaClient.send(
      new InvokeCommand({
        FunctionName: CREWPOPPY_RUNNER_FUNCTION,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  try {
    await invoke();
    console.log(`agent hand-off ${payload.messageId} -> ${payload.to}: invoked ${CREWPOPPY_RUNNER_FUNCTION}`);
  } catch (e) {
    const name = (e as Error).name ?? "";
    if (name === "ResourceNotFoundException" || name === "AccessDeniedException") {
      console.log(`agent hand-off ${payload.messageId} -> ${payload.to}: skipped (${name} — CrewPoppy not available)`);
      return;
    }
    try {
      await invoke();
      console.log(`agent hand-off ${payload.messageId} -> ${payload.to}: invoked on retry`);
    } catch (e2) {
      console.error(`agent hand-off ${payload.messageId} -> ${payload.to}: failed after one retry`, e2);
    }
  }
}

// ---- New-mail push notifications (Expo) -------------------------------------
// When a message lands in a real inbox, notify that mailbox's registered mobile
// devices via the Expo Push Service. Entirely best-effort: any failure is logged
// and NEVER blocks delivery. Tokens Expo reports as DeviceNotRegistered (the app
// was uninstalled / token rotated) are pruned from the registry.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const PUSH_CHANNEL_ID = "mail"; // Android notification channel (created on device)
const PUSH_CATEGORY_ID = "mail"; // matches the app-registered category (Mark as read action)

async function loadDeviceRegistry(address: string): Promise<DeviceRegistry> {
  if (!SETTINGS_TABLE) return { tokens: [] };
  try {
    const out = await ddb.send(
      new GetCommand({ TableName: SETTINGS_TABLE, Key: { pk: devicesSettingsKey(address) } }),
    );
    const raw = out.Item?.json;
    if (typeof raw !== "string") return { tokens: [] };
    return pruneDeviceTokens(JSON.parse(raw) as DeviceRegistry);
  } catch (e) {
    console.error(`failed to read device tokens for ${address}:`, e);
    return { tokens: [] };
  }
}

/** POST Expo push messages (chunked ≤100); return the tokens Expo says are dead. */
async function sendExpoPush(messages: ReturnType<typeof buildExpoPushMessages>): Promise<string[]> {
  const dead: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(batch),
      });
      if (!res.ok) {
        console.error(`expo push HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        continue;
      }
      const out = (await res.json()) as {
        data?: Array<{ status?: string; details?: { error?: string } }>;
      };
      (out.data ?? []).forEach((ticket, idx) => {
        if (ticket?.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          const to = batch[idx]?.to;
          if (to) dead.push(to);
        }
      });
    } catch (e) {
      console.error("expo push request failed:", e);
    }
  }
  return dead;
}

/** iOS app-icon badge = the mailbox's EXACT inbox unread count, computed when the
 *  push is sent (metadata-only COUNT query; consistent read so the message that
 *  triggered this push is included). Returns undefined on any failure — the push
 *  still goes out, just without a badge update. Page cap bounds the cost on very
 *  large mailboxes (the badge shows a floor, which iOS renders the same as 1000+). */
async function countInboxUnread(recipient: string): Promise<number | undefined> {
  try {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    for (let page = 0; page < 10; page++) {
      const out = await ddb.send(
        new QueryCommand({
          TableName: INDEX_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          FilterExpression: "#flags.#unread = :true",
          ExpressionAttributeNames: { "#flags": "flags", "#unread": "unread" },
          ExpressionAttributeValues: { ":pk": mailboxPk(recipient), ":prefix": folderPrefix("inbox"), ":true": true },
          Select: "COUNT",
          ConsistentRead: true,
          ExclusiveStartKey: lastKey,
        }),
      );
      count += out.Count ?? 0;
      lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!lastKey) break;
    }
    return count;
  } catch (e) {
    console.error(`unread count failed for ${recipient}:`, e);
    return undefined;
  }
}

/** Notify one mailbox's devices about a new inbox message (best-effort). */
async function notifyNewMail(
  recipient: string,
  title: string,
  body: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    const reg = await loadDeviceRegistry(recipient);
    if (reg.tokens.length === 0) return;
    const badge = await countInboxUnread(recipient);
    const messages = buildExpoPushMessages(reg.tokens, {
      title,
      body,
      data,
      badge,
      channelId: PUSH_CHANNEL_ID,
      categoryId: PUSH_CATEGORY_ID,
    });
    if (messages.length === 0) return;
    const dead = await sendExpoPush(messages);
    if (dead.length > 0 && SETTINGS_TABLE) {
      const pruned = removeDeviceTokens(reg, dead);
      await ddb
        .send(
          new PutCommand({
            TableName: SETTINGS_TABLE,
            Item: { pk: devicesSettingsKey(recipient), json: JSON.stringify(pruned) },
          }),
        )
        .catch((e) => console.error(`failed to prune dead tokens for ${recipient}:`, e));
    }
  } catch (e) {
    console.error(`push notify failed for ${recipient}:`, e);
  }
}

export async function handler(event: SESEvent): Promise<void> {
  const sodium = await sodiumReady; // ready once per cold start, before any sealing
  // Per-domain spam/auth policy, resolved on demand with a fallback chain:
  //   policy#<recipientDomain> → policy#default → built-in safe default.
  // Cached per invocation so each domain's doc is read at most once.
  const defaultSpamPolicy = (await loadSpamPolicyScoped("default")) ?? DEFAULT_POLICY.spam;
  const policyByDomain = new Map<string, DeploymentPolicy>([
    ["default", { ...DEFAULT_POLICY, spam: defaultSpamPolicy }],
  ]);
  async function policyForDomain(domain: string): Promise<DeploymentPolicy> {
    const key = (domain || "default").toLowerCase();
    const hit = policyByDomain.get(key);
    if (hit) return hit;
    const spam = (await loadSpamPolicyScoped(key)) ?? defaultSpamPolicy;
    const resolved: DeploymentPolicy = { ...DEFAULT_POLICY, spam };
    policyByDomain.set(key, resolved);
    return resolved;
  }
  // The real mailboxes (Cognito users). Mail to anything else is rejected.
  const knownMailboxes = await loadMailboxAddresses();

  // New-mail push notifications, queued during delivery and flushed at the end so
  // they never sit on the critical path of writing the inbox row.
  const pushJobs: Promise<void>[] = [];
  // CrewPoppy hand-offs for agent-owned mailboxes, queued the same way — the
  // inbox row is written first, so a hand-off failure can never lose mail.
  const agentJobs: Promise<void>[] = [];

  for (const rec of event.Records) {
    const { mail, receipt } = rec.ses;
    const messageId = mail.messageId;
    const key = `${INBOUND_PREFIX}${messageId}`;

    const obj = await s3.send(new GetObjectCommand({ Bucket: MAIL_BUCKET, Key: key }));
    const raw = await obj.Body!.transformToString();
    const sizeBytes = obj.ContentLength ?? Buffer.byteLength(raw);
    const parsed = await simpleParser(raw);

    const verdicts = verdictsFrom(receipt);
    const from = firstFrom(parsed.from);
    const to = toList(parsed.to);
    const threadId =
      deriveThreadId({
        references: parsed.references ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        messageId: parsed.messageId ?? messageId,
      }) || messageId;

    const date = (parsed.date ?? new Date()).toISOString();
    const subject = parsed.subject ?? "(no subject)";
    const snippet = (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140);

    // Who do we accept this message for? The LIVE Cognito mailbox set is the
    // authority — across EVERY hosted domain — so a mailbox on a newly-added
    // domain (e.g. marco@ollydigital.com) is delivered without re-deploying.
    // Only if that list can't be read (transient failure → empty set) do we fall
    // back to the static HOSTED_DOMAINS allowlist, so we never drop mail on a
    // lookup blip. (Only our own domains' MX point at SES, so the catch-all
    // receipt rule means `receipt.recipients` are already all ours.)
    const recipients = (receipt.recipients ?? []).map(normalizeAddress);

    // DMARC aggregate reports arrive as ordinary mail to the rua target we
    // publish (postmaster@<domain>). They're machine reports, not inbox mail:
    // tally their per-domain authentication counters, then ABSORB the message
    // (delete the raw S3 object, no inbox row, no bounce). Detection is gated to
    // these role addresses carrying a report-shaped attachment, so it never
    // touches normal mail; and it's fully fail-safe — any parse/IO error just
    // logs and the report is dropped, never blocking delivery. This is also why
    // postmaster@ needn't be a real mailbox: reports are consumed here directly.
    const reportRecipient = recipients.find(isDmarcRoleRecipient);
    const inboundAttachments = parsed.attachments ?? [];
    if (reportRecipient && hasReportCandidate(inboundAttachments)) {
      let ingested = false;
      try {
        ingested = await ingestDmarcReports(addressDomain(reportRecipient), inboundAttachments);
      } catch (e) {
        console.error(`dmarc ingest failed for ${messageId}:`, e);
      }
      // Only absorb (delete + skip) genuine reports; otherwise fall through so a
      // real message to a role address is still handled normally, not dropped.
      if (ingested) {
        await s3
          .send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: key }))
          .catch((e) => console.error(`failed to delete dmarc report object ${key}:`, e));
        continue;
      }
    }

    const enforceKnown = knownMailboxes.size > 0;
    const known = enforceKnown
      ? recipients.filter((r) => isKnownMailbox(r, knownMailboxes))
      : recipients.filter(isHosted);
    const unknown = enforceKnown ? recipients.filter((r) => !isKnownMailbox(r, knownMailboxes)) : [];

    // Mail addressed only to non-existent mailboxes: store nothing (no DynamoDB
    // row), DELETE the raw object SES wrote to S3, and bounce a genuine sender.
    // Forged spam (failed auth) is dropped silently to avoid backscatter.
    if (known.length === 0) {
      for (const r of unknown) {
        console.log(`reject ${messageId} -> ${r}: no-such-mailbox`);
        if (senderAuthenticated(verdicts)) await sendUnknownRecipientBounce(r, from.address, subject);
      }
      await s3
        .send(new DeleteObjectCommand({ Bucket: MAIL_BUCKET, Key: key }))
        .catch((e) => console.error(`failed to delete unstored inbound object ${key}:`, e));
      continue;
    }

    // ── Mailbox encryption decision (docs/mailbox-encryption-design.md) ──────
    // Seal the body + attachments at rest IFF every local recipient is activated
    // (has a public key). One content key per message; the shared ciphertext is
    // written once and the content key is wrapped per recipient below. If ANY
    // recipient isn't activated yet, the whole message is stored in clear so that
    // recipient can still read it after first login (the bounded pre-activation
    // window, §10) — the rare mixed-recipient message degrades to plaintext-at-rest.
    const pubByRecipient = new Map<string, string>();
    if (ENCRYPTION_ENABLED) {
      for (const r of known) {
        const pub = await loadMailboxPubKey(r);
        if (pub) pubByRecipient.set(r, pub);
      }
    }
    const contentKey =
      ENCRYPTION_ENABLED && known.every((r) => pubByRecipient.has(r)) ? generateContentKey(sodium) : null;

    // Extract each attachment to its own S3 object so the client can download it
    // on demand (one copy per message, shared across recipients). Sealed under the
    // message content key when the mailbox is activated.
    const attachments: AttachmentMeta[] = [];
    const parsedAttachments = parsed.attachments ?? [];
    for (let i = 0; i < parsedAttachments.length; i++) {
      const a = parsedAttachments[i]!;
      const filename = a.filename ?? `attachment-${i}`;
      // Some senders attach files as application/octet-stream; infer a real type
      // from the extension so the client can preview/open it.
      const contentType = resolveContentType(a.contentType, filename);
      const aKey = attachmentS3Key(messageId, i, filename);
      const size = a.size ?? a.content?.length ?? 0;
      // Ciphertext is opaque bytes stored as octet-stream; the real content type
      // lives in AttachmentMeta and is applied client-side after decryption.
      const body = contentKey ? encryptWithContentKey(sodium, contentKey, a.content) : a.content;
      await s3.send(
        new PutObjectCommand({
          Bucket: MAIL_BUCKET,
          Key: aKey,
          Body: body,
          ContentType: contentKey ? "application/octet-stream" : contentType,
        }),
      );
      attachments.push({ filename, contentType, sizeBytes: size, s3Key: aKey });
    }

    // Seal the body by OVERWRITING the raw .eml with ciphertext (scrubs the
    // plaintext SES wrote to S3). The client fetches this object, recovers the
    // content key from its per-recipient wrap, decrypts, then parses as today.
    // We seal a LIGHTWEIGHT reading copy (attachments already live in their own S3
    // objects, fetched on demand) so opening a message with a big attachment doesn't
    // download+decrypt+parse those megabytes just to show the body. readingCopyEml
    // returns the full raw whenever stripping isn't provably safe (see below).
    if (contentKey) {
      const readEml = readingCopyEml(raw, parsed, messageId);
      const sealedEml = encryptWithContentKey(sodium, contentKey, sodium.from_string(readEml));
      await s3.send(
        new PutObjectCommand({ Bucket: MAIL_BUCKET, Key: key, Body: sealedEml, ContentType: "application/octet-stream" }),
      );
    }

    // Deliver to each real recipient (apply spam/auth policy + storage quota).
    for (const recipient of known) {
      // Use this recipient's domain policy (falls back to the deployment default).
      const policy = await policyForDomain(addressDomain(recipient));
      const decision = classifyDelivery(from.address, verdicts, policy);
      if (decision.folder === null) {
        // Rejected by policy (virus/spam/block-list). Raw object is left in S3
        // for audit; the janitor sweeps unindexed inbound objects later.
        console.log(`drop ${messageId} -> ${recipient}: ${decision.reason}`);
        continue;
      }

      // Enforce the mailbox storage quota: if this message would push the mailbox
      // over its limit, don't store it and bounce a "mailbox full" notice to the
      // sender (skipped when no quota is set).
      const quota = await quotaFor(recipient);
      if (quota !== null) {
        const used = await mailboxUsage(mailboxPk(recipient));
        if (wouldExceedQuota(used, sizeBytes, quota)) {
          console.log(`quota-full ${messageId} -> ${recipient}: used=${used} +${sizeBytes} > ${quota}`);
          await sendQuotaBounce(recipient, from.address, subject);
          continue;
        }
      }

      // When encrypted, wrap the message content key to THIS recipient's pubkey
      // and blank the snippet (it's body text). Subject + routing metadata stay
      // clear (the Lambda needs them; disclosed to the admin).
      const encWrappedKey = contentKey ? wrapContentKey(sodium, pubByRecipient.get(recipient)!, contentKey) : undefined;

      const meta: MessageMeta = {
        domain: addressDomain(recipient),
        mailbox: recipient,
        messageId,
        threadId,
        folder: decision.folder,
        from,
        to,
        subject,
        snippet: encWrappedKey ? "" : snippet,
        date,
        flags: { unread: true },
        hasAttachments: attachments.length > 0,
        attachments: attachments.length > 0 ? attachments : undefined,
        verdicts,
        s3Key: key,
        sizeBytes,
        encrypted: encWrappedKey ? true : undefined,
        encWrappedKey,
      };

      await ddb.send(
        new PutCommand({
          TableName: INDEX_TABLE,
          Item: { pk: mailboxPk(recipient), sk: messageSk(decision.folder, date, messageId), ...meta },
        }),
      );

      // Fan out a new-mail push to this mailbox's mobile devices — inbox only, so
      // spam/quarantined mail never buzzes the phone. Queued; flushed below.
      if (decision.folder === "inbox") {
        pushJobs.push(
          notifyNewMail(recipient, from.name || from.address, subject, {
            messageId,
            mailbox: recipient,
            folder: decision.folder,
            threadId,
          }),
        );

        // Agent-owned mailbox? Hand a plain-text COPY to CrewPoppy's runner.
        // Inbox deliveries only: policy-junked/rejected mail never reaches the
        // runner (and CrewPoppy independently re-checks the verdicts we pass —
        // which are SES's real receipt verdicts, never synthesized). The SES
        // messageId is CrewPoppy's idempotency key, so a redelivered message
        // carries the same id. This block runs AFTER the row write above and is
        // queued off the critical path — delivery never depends on CrewPoppy.
        agentJobs.push(
          (async () => {
            if (!(await isAgentOwned(recipient))) return;
            await handOffToAgent(
              buildAgentMailPayload({
                to: recipient,
                from: from.address,
                subject,
                text: parsed.text ?? undefined,
                html: typeof parsed.html === "string" ? parsed.html : undefined,
                messageId,
                receivedAt: mail.timestamp ?? date,
                verdicts,
              }),
            );
          })().catch((e) => console.error(`agent hand-off failed for ${recipient}:`, e)),
        );
      }
    }
  }

  // Flush queued pushes + agent hand-offs concurrently. Each is already
  // failure-isolated, so a bad token, an Expo outage, or a missing CrewPoppy can
  // never affect mail that's already safely stored.
  const jobs = [...pushJobs, ...agentJobs];
  if (jobs.length > 0) await Promise.allSettled(jobs);
}
