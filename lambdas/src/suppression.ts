import type { SNSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { normalizeAddress, addressDomain } from "@mailpoppy/core";

/**
 * SES bounce/complaint notifications arrive via SNS. Two jobs:
 *  1. Maintain the suppression list (settings table, `SUPPRESS#<address>`) so
 *     future sends skip these recipients — mandatory once sending, or AWS
 *     throttles/suspends the account (DESIGN §9.2 / §13). The access-API send
 *     path consults this list.
 *  2. Tally per-domain "sending health": each event is attributed to the domain
 *     that sent the message (`STAT#<domain>#<YYYY-MM-DD>` daily counters), and the
 *     suppression entry records that domain — so the desktop's per-domain Sending
 *     Health view can show which domain is generating bounces/complaints. These
 *     counters are forward-looking (they accrue from when this Lambda is deployed).
 */
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";

interface SesMail {
  source?: string;
  commonHeaders?: { from?: string[] };
}
interface SesNotification {
  notificationType?: string;
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
  mail?: SesMail;
}

/**
 * The domain that sent the message that bounced/complained. Prefer the visible
 * From header (the mailbox's own domain) over the envelope `source`, which may be
 * a custom MAIL FROM subdomain (e.g. mail.example.com) that wouldn't match the
 * domain the admin manages.
 */
function sendingDomain(mail: SesMail | undefined): string | undefined {
  const candidate = mail?.commonHeaders?.from?.[0] ?? mail?.source;
  if (!candidate) return undefined;
  const angle = candidate.match(/<([^>]+)>/);
  const dom = addressDomain(normalizeAddress(angle ? angle[1] : candidate));
  return dom || undefined;
}

/** Increment a per-domain daily counter (creates the row on first event). */
async function recordEvent(domain: string | undefined, field: "bounces" | "complaints"): Promise<void> {
  if (!domain || !SETTINGS_TABLE) return;
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  await ddb.send(
    new UpdateCommand({
      TableName: SETTINGS_TABLE,
      Key: { pk: `STAT#${domain}#${day}` },
      UpdateExpression: "SET #domain = if_not_exists(#domain, :domain), #day = if_not_exists(#day, :day) ADD #f :one",
      ExpressionAttributeNames: { "#domain": "domain", "#day": "day", "#f": field },
      ExpressionAttributeValues: { ":domain": domain, ":day": day, ":one": 1 },
    }),
  );
}

async function suppress(address: string, reason: string, detail: string, domain?: string): Promise<void> {
  const addr = normalizeAddress(address);
  if (!addr) return;
  await ddb.send(
    new PutCommand({
      TableName: SETTINGS_TABLE,
      Item: { pk: `SUPPRESS#${addr}`, address: addr, reason, detail, suppressedAt: new Date().toISOString(), domain },
    }),
  );
  console.log(`suppressed ${addr} (${reason}/${detail})${domain ? ` [${domain}]` : ""}`);
}

export async function handler(event: SNSEvent): Promise<void> {
  for (const rec of event.Records) {
    let n: SesNotification;
    try {
      n = JSON.parse(rec.Sns.Message) as SesNotification;
    } catch {
      console.error("unparseable SNS message");
      continue;
    }
    const domain = sendingDomain(n.mail);

    if (n.notificationType === "Bounce" && n.bounce) {
      const type = n.bounce.bounceType ?? "Unknown";
      // Only permanent bounces are suppressed; transient bounces may recover.
      if (type === "Permanent") {
        for (const r of n.bounce.bouncedRecipients ?? []) {
          if (r.emailAddress) {
            await suppress(r.emailAddress, "bounce", type, domain);
            await recordEvent(domain, "bounces");
          }
        }
      }
    } else if (n.notificationType === "Complaint" && n.complaint) {
      for (const r of n.complaint.complainedRecipients ?? []) {
        if (r.emailAddress) {
          await suppress(r.emailAddress, "complaint", "abuse", domain);
          await recordEvent(domain, "complaints");
        }
      }
    }
  }
}
