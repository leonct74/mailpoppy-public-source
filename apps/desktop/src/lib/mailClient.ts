// The desktop's view of the mailbox plane. The real implementation is the
// shared @mailpoppy/api-client (Cognito-JWT calls to the deployment's API
// Gateway). Until a backend is deployed, a DemoMailClient with the SAME surface
// lets the inbox UI run fully offline — so the view code never needs to know
// which one it's talking to (and tests inject their own).
import { MailpoppyClient } from "@mailpoppy/api-client";
import type { MessageMeta, Folder, MessageFlags } from "@mailpoppy/core";

export interface ListOptions {
  folder: Folder;
  limit?: number;
  cursor?: string;
}
export interface ListResult {
  items: MessageMeta[];
  cursor?: string;
}
export interface SendAttachment {
  filename: string;
  contentType: string;
  /** base64-encoded file bytes. */
  contentBase64: string;
}
export interface SendInput {
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: SendAttachment[];
}

export interface AttachmentLink {
  url: string;
  filename?: string;
  contentType?: string;
}
export interface MailboxUsage {
  email: string;
  usedBytes: number;
  messageCount: number;
  quotaBytes: number | null;
}

/** The exact surface InboxView depends on — satisfied by both clients below. */
export interface MailClient {
  list(opts: ListOptions): Promise<ListResult>;
  getRaw(messageId: string): Promise<{ eml: string }>;
  getAttachmentUrl(messageId: string, index: number): Promise<AttachmentLink>;
  setFlags(messageId: string, flags: Partial<MessageFlags>): Promise<MessageMeta>;
  move(messageId: string, folder: Folder): Promise<MessageMeta>;
  send(input: SendInput): Promise<{ messageId: string }>;
  getUsage(): Promise<MailboxUsage>;
}

// ---- Demo client (in-memory) ------------------------------------------------

const MAILBOX = "you@ollydigital.com";

function meta(p: Partial<MessageMeta> & Pick<MessageMeta, "messageId" | "subject" | "from" | "date" | "folder">): MessageMeta {
  return {
    domain: "ollydigital.com",
    mailbox: MAILBOX,
    threadId: p.messageId,
    to: [{ address: MAILBOX }],
    snippet: "",
    flags: { unread: true },
    hasAttachments: false,
    s3Key: `inbound/${p.messageId}`,
    sizeBytes: 2048,
    ...p,
  };
}

function seed(): MessageMeta[] {
  return [
    meta({
      messageId: "demo-1",
      subject: "Welcome to MailPoppy 🌸",
      from: { name: "MailPoppy", address: "hello@mailpoppy.app" },
      date: "2026-06-02T08:30:00.000Z",
      snippet: "Your mail now lives in your own AWS account. Here's how it works…",
      folder: "inbox",
      flags: { unread: true, starred: true },
    }),
    meta({
      messageId: "demo-2",
      subject: "Your SES domain is verified",
      from: { name: "AWS Notifications", address: "no-reply@sns.amazonaws.com" },
      date: "2026-06-02T07:15:00.000Z",
      snippet: "DKIM verification completed for ollydigital.com. You can now receive mail.",
      folder: "inbox",
      verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
    }),
    meta({
      messageId: "demo-3",
      subject: "Re: Q2 forecast",
      from: { name: "Dana Vandenberg", address: "dana@partner.example" },
      date: "2026-06-01T16:42:00.000Z",
      snippet: "Thanks — numbers look good. Let's sync Thursday.",
      folder: "inbox",
      flags: { unread: false },
      hasAttachments: true,
      attachments: [{ filename: "forecast-q2.xlsx", contentType: "application/vnd.openxmlformats", sizeBytes: 18234 }],
    }),
    meta({
      messageId: "demo-4",
      subject: "You won a prize!!!",
      from: { address: "winner@totally-legit.example" },
      date: "2026-05-31T21:03:00.000Z",
      snippet: "Click here to claim your reward before it expires…",
      folder: "junk",
      verdicts: { spam: "FAIL", virus: "PASS", spf: "FAIL", dkim: "FAIL", dmarc: "FAIL" },
    }),
    meta({
      messageId: "demo-5",
      subject: "Re: Welcome to MailPoppy 🌸",
      from: { address: MAILBOX },
      to: [{ address: "hello@mailpoppy.app" }],
      date: "2026-06-02T09:05:00.000Z",
      snippet: "Looks great, thanks!",
      folder: "sent",
      flags: { unread: false },
    }),
  ];
}

/** Fully in-memory MailClient; mutations persist for the session. */
export class DemoMailClient implements MailClient {
  private store: MessageMeta[];
  constructor(initial: MessageMeta[] = seed()) {
    this.store = initial.map((m) => ({ ...m }));
  }

  async list(opts: ListOptions): Promise<ListResult> {
    const items = this.store
      .filter((m) => m.folder === opts.folder)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, opts.limit ?? 50);
    return { items };
  }

  async getRaw(messageId: string): Promise<{ eml: string }> {
    const m = this.find(messageId);
    if (!m) throw new Error("not found");
    const eml = [
      `From: ${m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address}`,
      `To: ${m.to.map((t) => t.address).join(", ")}`,
      `Subject: ${m.subject}`,
      `Date: ${new Date(m.date).toUTCString()}`,
      `Message-ID: <${m.messageId}>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      m.snippet || "(no body in demo data)",
    ].join("\r\n");
    return { eml };
  }

  async getAttachmentUrl(messageId: string, index: number): Promise<AttachmentLink> {
    const att = this.find(messageId)?.attachments?.[index];
    // Demo mode has no real S3 object — hand back an inline placeholder.
    return {
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(`Demo attachment: ${att?.filename ?? "file"}`)}`,
      filename: att?.filename,
      contentType: att?.contentType,
    };
  }

  async setFlags(messageId: string, flags: Partial<MessageFlags>): Promise<MessageMeta> {
    const m = this.find(messageId);
    if (!m) throw new Error("not found");
    m.flags = { ...m.flags, ...flags };
    return { ...m };
  }

  async move(messageId: string, folder: Folder): Promise<MessageMeta> {
    const m = this.find(messageId);
    if (!m) throw new Error("not found");
    m.folder = folder;
    return { ...m };
  }

  async send(input: SendInput): Promise<{ messageId: string }> {
    const messageId = `demo-sent-${Date.now()}`;
    this.store.push(
      meta({
        messageId,
        subject: input.subject,
        from: { address: MAILBOX },
        to: input.to.map((address) => ({ address })),
        date: new Date().toISOString(),
        snippet: (input.text ?? input.html ?? "").replace(/<[^>]+>/g, " ").slice(0, 140),
        folder: "sent",
        flags: { unread: false },
      }),
    );
    return { messageId };
  }

  async getUsage(): Promise<MailboxUsage> {
    const usedBytes = this.store.reduce((n, m) => n + (m.sizeBytes ?? 0), 0);
    return { email: MAILBOX, usedBytes, messageCount: this.store.length, quotaBytes: 1024 ** 3 };
  }

  private find(messageId: string): MessageMeta | undefined {
    return this.store.find((m) => m.messageId === messageId);
  }
}

// ---- Factory ----------------------------------------------------------------

export interface MailConfig {
  apiBaseUrl: string;
  getToken: () => Promise<string>;
}

/**
 * Returns the live client when the deployment is configured, otherwise the demo
 * client. (Phase 2 backend exists but isn't deployed yet → demo by default.)
 */
export function makeMailClient(config?: MailConfig): MailClient {
  if (config?.apiBaseUrl) {
    return new MailpoppyClient({ apiBaseUrl: config.apiBaseUrl, getToken: config.getToken });
  }
  return new DemoMailClient();
}
