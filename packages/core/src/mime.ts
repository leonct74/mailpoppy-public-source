// Hand-built RFC 5322 / MIME message builder, used to send mail with attachments
// as a raw message (SES SendEmail with Content.Raw). The SESv2 "Simple" message
// type with Attachments produced messages Gmail refused to open ("Unsupported
// file type"); building the multipart ourselves gives full control over the
// structure, each part's Content-Type, and base64 encoding — the universally
// compatible approach. Pure (no AWS deps) so it lives in core and is unit-tested.

export interface MimeAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface MimeMessageInput {
  from: string;
  to: string[];
  /** Visible carbon-copy recipients (added as a Cc header). */
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** RFC Message-ID value WITHOUT the angle brackets. */
  messageId: string;
  date: Date | string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
}

const CRLF = "\r\n";

/** Base64-encode bytes/text and wrap at 76 chars per RFC 2045. */
function b64(data: Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const encoded = buf.toString("base64");
  return (encoded.match(/.{1,76}/g) ?? [""]).join(CRLF);
}

/** A unique multipart boundary token. */
function boundary(tag: string): string {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `=_mailpoppy_${tag}_${rand}`;
}

/** RFC 2047-encode a header value if it contains non-ASCII; otherwise pass through. */
function headerWord(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** A text part: Content-Type + base64 transfer-encoding + the encoded body. */
function textEntity(contentType: string, content: string): string {
  return [`Content-Type: ${contentType}`, "Content-Transfer-Encoding: base64", "", b64(content)].join(CRLF);
}

/** The body entity (text, html, or multipart/alternative of both), incl. its own headers. */
function bodyEntity(text: string | undefined, html: string | undefined): string {
  if (text && html) {
    const alt = boundary("alt");
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      textEntity("text/plain; charset=utf-8", text),
      `--${alt}`,
      textEntity("text/html; charset=utf-8", html),
      `--${alt}--`,
    ].join(CRLF);
  }
  if (html) return textEntity("text/html; charset=utf-8", html);
  return textEntity("text/plain; charset=utf-8", text ?? "");
}

/** An attachment part (base64), with Content-Disposition: attachment. */
function attachmentEntity(a: MimeAttachment): string {
  const name = headerWord(a.filename).replace(/"/g, "");
  return [
    `Content-Type: ${a.contentType}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    b64(a.bytes),
  ].join(CRLF);
}

/** A minimal view of a received attachment, enough to decide whether it's safe to
 *  drop from a reading copy. (Kept parser-agnostic so it's unit-testable in core.) */
export interface AttachmentSummary {
  /** Content-Disposition: "attachment" | "inline" | null/undefined. */
  disposition?: string | null;
  /** Content-ID, present when the body references the part via cid:. */
  cid?: string | null;
  /** True when the part is a `related` (inline) resource of the body. */
  related?: boolean;
  sizeBytes?: number;
}

/**
 * Decide whether a message's attachments can be SAFELY stripped to a lightweight
 * reading copy (see buildReadingEml). Only when: there's at least one attachment,
 * NONE are inline/related/cid (those are body content and must stay so the body
 * renders), and the total payload is big enough to be worth removing. Pure so it's
 * unit-tested; the lambda wraps it with the actual rebuild + fail-safe fallback.
 */
export function canStripForReadingCopy(atts: AttachmentSummary[], minBytes: number): boolean {
  if (atts.length === 0) return false;
  if (atts.some((a) => a.related === true || a.disposition === "inline" || !!a.cid)) return false;
  const total = atts.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  return total >= minBytes;
}

/**
 * A lightweight "reading copy" of a received message: the SAME body (text/html) and
 * the SAME attachment list, but each attachment reduced to a zero-byte STUB — its
 * Content-Type + filename are kept (so the reader still lists it) while the megabytes
 * of payload are dropped. Received attachments are stored as their own S3 objects and
 * fetched on demand, so the copy the reader downloads to show the BODY needn't carry
 * them. Reuses buildMimeMessage — an empty-bytes attachment IS the stub — so the output
 * is the exact format clients already parse for Sent mail. Only safe for messages with
 * no INLINE/cid images (those are body content); the caller gates on that.
 */
export function buildReadingEml(
  m: Omit<MimeMessageInput, "attachments"> & {
    attachments?: { filename: string; contentType: string }[];
  },
): string {
  return buildMimeMessage({
    ...m,
    attachments: (m.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      bytes: new Uint8Array(0),
    })),
  });
}

/** Build a complete raw MIME message string (CRLF line endings). */
export function buildMimeMessage(m: MimeMessageInput): string {
  const att = m.attachments ?? [];
  const dateStr = (m.date instanceof Date ? m.date : new Date(m.date)).toUTCString();

  const headers = [
    `From: ${m.from}`,
    `To: ${m.to.join(", ")}`,
    // Cc is visible to all recipients; Bcc is intentionally NOT a header — bcc
    // recipients are delivered via the SES Destination only, never disclosed here.
    ...(m.cc && m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    `Subject: ${headerWord(m.subject)}`,
    `Date: ${dateStr}`,
    `Message-ID: <${m.messageId}>`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    "MIME-Version: 1.0",
  ];

  const body = bodyEntity(m.text, m.html);

  if (att.length === 0) {
    // The body entity carries the top-level Content-Type; append it after the headers.
    return headers.join(CRLF) + CRLF + body + CRLF;
  }

  const mixed = boundary("mixed");
  headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

  let parts = `--${mixed}${CRLF}${body}${CRLF}`;
  for (const a of att) parts += `--${mixed}${CRLF}${attachmentEntity(a)}${CRLF}`;
  parts += `--${mixed}--${CRLF}`;

  // Header block, blank line, then the multipart body.
  return headers.join(CRLF) + CRLF + CRLF + parts;
}
