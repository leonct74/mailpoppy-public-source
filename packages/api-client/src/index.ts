import type { MessageMeta, Folder, MessageFlags, MailboxKeyRecord } from "@mailpoppy/core";

/**
 * An API call that failed. `message` is always safe to show a user directly;
 * `status` (0 means the request never reached the server) and `detail` (the raw
 * server body) are kept for logging/debugging, not for display.
 */
export class MailpoppyApiError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string, message: string) {
    super(message);
    this.name = "MailpoppyApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Pull out a human-readable message the access-api Lambda intentionally returned
 * (`{ "error": "…" }`). API Gateway's own failures use `{ "message": "…" }`
 * (e.g. the 413 "Request entity too large") — we deliberately ignore those so
 * infrastructure noise never reaches a user.
 */
function serverError(detail: string): string | undefined {
  try {
    const j = JSON.parse(detail) as { error?: unknown };
    if (typeof j.error === "string" && j.error.trim()) return j.error.trim();
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Map an HTTP status (0 = network failure) to a friendly, user-facing message. */
export function friendlyApiMessage(status: number, detail = ""): string {
  switch (status) {
    case 0:
      return "Couldn't reach the mail server. Check your connection and try again.";
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return serverError(detail) ?? "You don't have permission to do that.";
    case 404:
      return "That message couldn't be found — it may have been moved or deleted.";
    case 413:
      return "This message is too large to send. Attachments must total under about 4 MB — remove or shrink one and try again.";
    case 408:
    case 429:
      return "The mail server is busy. Please wait a moment and try again.";
    default:
      if (status >= 500) return "The mail server ran into a problem. Please try again in a moment.";
      return serverError(detail) ?? "Something went wrong. Please try again.";
  }
}

export interface MailpoppyClientConfig {
  /** Base URL of the deployment's API Gateway. */
  apiBaseUrl: string;
  /** Returns a fresh Cognito id token for the signed-in mailbox user. */
  getToken: () => Promise<string>;
}

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
  /** base64-encoded file bytes — the inline path, for small files. */
  contentBase64?: string;
  /**
   * S3 staging key returned by presignAttachment() — the large-file path. The
   * file was uploaded straight to S3, so it never travels through the API. Set
   * either this or contentBase64, not both.
   */
  s3Key?: string;
}
export interface PresignAttachmentInput {
  filename: string;
  contentType: string;
  sizeBytes: number;
}
export interface PresignAttachmentResult {
  /** Short-lived presigned S3 PUT URL — upload the bytes here. */
  uploadUrl: string;
  /** The staging key to pass back as SendAttachment.s3Key. */
  key: string;
}
export interface SendInput {
  to: string[];
  /** Visible carbon-copy recipients. */
  cc?: string[];
  /** Blind carbon-copy recipients — delivered, but never shown in the message headers. */
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: SendAttachment[];
  /** When sending a saved draft, its id — the server removes it after sending. */
  draftId?: string;
}
export interface SaveDraftInput {
  /** Omit to create a new draft; pass to update an existing one in place. */
  draftId?: string;
  to?: string[];
  subject?: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
}
export interface MailboxUsage {
  email: string;
  usedBytes: number;
  messageCount: number;
  quotaBytes: number | null;
}

/**
 * Talks to the deployment's Cognito-authorized access API (API Gateway).
 * Shared by the desktop (React) and mobile (React Native) clients.
 * The mail path NEVER uses AWS credentials — only a Cognito JWT (DESIGN §6).
 */
export class MailpoppyClient {
  constructor(private readonly cfg: MailpoppyClientConfig) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await this.cfg.getToken();
    let res: Response;
    try {
      res = await fetch(`${this.cfg.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (e) {
      // The request never reached the server (offline, DNS, TLS, aborted).
      throw new MailpoppyApiError(0, String(e), friendlyApiMessage(0));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new MailpoppyApiError(res.status, detail, friendlyApiMessage(res.status, detail));
    }
    return (await res.json()) as T;
  }

  list(opts: ListOptions): Promise<ListResult> {
    const q = new URLSearchParams({ folder: String(opts.folder) });
    if (opts.limit) q.set("limit", String(opts.limit));
    if (opts.cursor) q.set("cursor", opts.cursor);
    return this.req<ListResult>(`/messages?${q.toString()}`);
  }
  // Returns the raw EML plus the encryption meta, so a caller that opened the
  // message from a notification (no meta in hand) can decrypt without a list scan.
  // `encrypted`/`encWrappedKey` are absent for mail stored in clear, and absent from
  // an older backend that predates this — callers must treat them as best-effort.
  // Large messages (a big PDF attachment) exceed Lambda's 6 MB response cap, so the
  // backend returns `emlUrl` — a short-lived presigned S3 URL — instead of inlining
  // the bytes. Fetch it here so every caller keeps seeing a plain `{ eml }` and no
  // screen has to know the difference. Ciphertext stays ciphertext: callers decrypt
  // exactly as before.
  async getRaw(messageId: string): Promise<{ eml: string; encrypted?: boolean; encWrappedKey?: string }> {
    const r = await this.req<{
      eml?: string;
      emlUrl?: string;
      encrypted?: boolean;
      encWrappedKey?: string;
      error?: string;
    }>(`/messages/${encodeURIComponent(messageId)}/raw`);
    if (typeof r.eml === "string") return { ...r, eml: r.eml };
    if (r.emlUrl) {
      const res = await fetch(r.emlUrl);
      if (!res.ok) throw new Error(`Couldn't download this message (${res.status}). Please try again.`);
      return { ...r, eml: await res.text() };
    }
    throw new Error(r.error ?? "This message couldn't be opened.");
  }
  getAttachmentUrl(
    messageId: string,
    index: number,
  ): Promise<{ url: string; filename?: string; contentType?: string }> {
    return this.req(`/messages/${encodeURIComponent(messageId)}/attachments/${index}`);
  }
  setFlags(messageId: string, flags: Partial<MessageFlags>): Promise<MessageMeta> {
    return this.req(`/messages/${encodeURIComponent(messageId)}/flags`, {
      method: "PATCH",
      body: JSON.stringify(flags),
    });
  }
  move(messageId: string, folder: Folder): Promise<MessageMeta> {
    return this.req(`/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: JSON.stringify({ folder }),
    });
  }
  /** Permanently delete every message in the Trash folder. Irreversible. */
  emptyTrash(): Promise<{ ok: boolean; deleted: number }> {
    return this.req(`/trash/empty`, { method: "POST" });
  }
  send(input: SendInput): Promise<{ messageId: string }> {
    return this.req(`/send`, { method: "POST", body: JSON.stringify(input) });
  }
  /** The deployment's outbound limits (e.g. the admin-set max attachment size). */
  getSendConfig(): Promise<{ maxAttachmentBytes: number }> {
    return this.req(`/send-config`);
  }
  /**
   * Reserve an S3 staging slot for a large attachment and get a presigned PUT URL.
   * Upload the bytes to `uploadUrl` (via putToPresignedUrl or, on React Native,
   * expo-file-system), then pass `key` back as SendAttachment.s3Key.
   */
  presignAttachment(input: PresignAttachmentInput): Promise<PresignAttachmentResult> {
    return this.req(`/attachments/presign`, { method: "POST", body: JSON.stringify(input) });
  }
  /** Create or update a draft. Returns the (possibly newly minted) draft id. */
  saveDraft(input: SaveDraftInput): Promise<{ draftId: string } & MessageMeta> {
    return this.req(`/drafts`, { method: "POST", body: JSON.stringify(input) });
  }
  deleteDraft(draftId: string): Promise<{ ok: true }> {
    return this.req(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
  }
  getUsage(): Promise<MailboxUsage> {
    return this.req(`/usage`);
  }
  /**
   * The signed-in mailbox's stored key record. `record: null` means none exists
   * yet — the client should generate a keypair this login (see
   * establishMailboxKeys in @mailpoppy/core). The record is public material only:
   * the admin can read it and still cannot decrypt mail.
   */
  getMailboxKeys(): Promise<{ record: MailboxKeyRecord | null }> {
    return this.req(`/mailbox-keys`);
  }
  /** Store the mailbox key record (first-login keygen, re-key, or password change). */
  putMailboxKeys(record: MailboxKeyRecord): Promise<{ ok: true }> {
    return this.req(`/mailbox-keys`, { method: "PUT", body: JSON.stringify(record) });
  }
  /** Register / refresh this device's Expo push token for new-mail notifications. */
  registerDevice(token: string, platform: "ios" | "android"): Promise<{ ok: true }> {
    return this.req(`/devices`, { method: "POST", body: JSON.stringify({ token, platform }) });
  }
  /** Unregister a device token (on sign-out, or when it's reported stale). */
  unregisterDevice(token: string): Promise<{ ok: true }> {
    return this.req(`/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
  }
}

/**
 * Upload raw bytes to a presigned S3 PUT URL. The signed URL is itself the
 * credential, so this sends NO Authorization header — it's a direct upload to
 * S3, not an API call. The content-type MUST match the one passed to
 * presignAttachment() or S3 rejects the signature. Used by the browser/desktop
 * clients; React Native uploads via expo-file-system's uploadAsync instead.
 * Throws MailpoppyApiError on failure.
 */
export async function putToPresignedUrl(
  uploadUrl: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: "PUT",
      body: body as BodyInit,
      headers: { "content-type": contentType },
    });
  } catch (e) {
    throw new MailpoppyApiError(0, String(e), friendlyApiMessage(0));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new MailpoppyApiError(res.status, detail, friendlyApiMessage(res.status, detail));
  }
}
