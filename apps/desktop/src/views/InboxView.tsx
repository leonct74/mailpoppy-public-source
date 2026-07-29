import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Inbox as InboxIcon,
  Send,
  FileText,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  PenSquare,
  Search,
  Star,
  Paperclip,
  Reply as ReplyIcon,
  ReplyAll,
  Forward,
  MailOpen,
  Mail,
  AtSign,
  Undo2,
  Download,
  X,
  Eye,
  ExternalLink,
  Copy,
  ImageOff,
  ShieldQuestion,
  RefreshCw,
  Lock,
  ChevronLeft,
  ChevronDown,
  Check,
  Plus,
  CheckCircle2,
} from "lucide-react";
import type { MessageMeta, Folder } from "@mailpoppy/core";
import { formatBytes, usagePercent, usageLevel } from "@mailpoppy/core";
import { makeMailClient, type MailClient, type SendAttachment, type MailboxUsage } from "../lib/mailClient";
import { loadListCache, saveListCache, loadCachedEml, saveCachedEml } from "../lib/mailCache";
import { filesToAttachments } from "../lib/attachments";
import { openExternal } from "../lib/openExternal";
import { saveBytesToDownloads } from "../lib/localDownload";
import { decryptEml, decryptAttachmentBytes } from "../lib/mailboxKeys";
import { SecurityInfo } from "./SecurityInfo";
import { parseBody, sanitizeHtml, type ParsedBody } from "../lib/mailBody";
import { PdfViewer } from "./PdfViewer";
import { buildReply, type ComposeInit, type ReplyMode } from "../lib/reply";
import { renderMarkdown } from "../lib/compose";
import { filterMessages } from "../lib/search";
import { Button, Spinner, cn } from "../ui";
import { friendlyError } from "../lib/errors";

// Phase 2 mailbox UI: browse folders, read a message (sanitized HTML, remote
// images blocked by default), toggle read/star, move to trash / restore, and
// compose → send. Talks to a MailClient (the shared api-client against a
// deployed backend, or the demo client offline) — so this view is identical
// for desktop and, later, mobile.

const FOLDERS: Folder[] = ["inbox", "sent", "drafts", "trash", "junk"];
const FOLDER_LABEL: Record<string, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  trash: "Trash",
  junk: "Junk",
};
const FOLDER_ICON: Record<string, typeof InboxIcon> = {
  inbox: InboxIcon,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: ShieldAlert,
};

function fromLabel(m: MessageMeta): string {
  return m.from.name || m.from.address || "(unknown)";
}
function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * True when there's room for the three-pane layout. Inside the AgentsPoppy frame
 * (a ~520–700px iframe) this is false, so the inbox collapses to a single-column,
 * navigate-to-read layout (like the mobile app) and the message body gets the full
 * width. Defaults to wide where `matchMedia` is unavailable (jsdom/SSR), keeping
 * the tests on the three-pane layout.
 */
function useIsWide(minPx = 900): boolean {
  const query = `(min-width: ${minPx}px)`;
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [query]);
  return wide;
}

export function InboxView({
  client,
  demo,
  onConnect,
  mailboxEmail,
  accounts,
  onSwitchMailbox,
  onAddMailbox,
  onRemoveMailbox,
}: {
  client?: MailClient;
  demo?: boolean;
  onConnect?: () => void;
  /** The signed-in mailbox address, shown atop the folder pane so it's always
   *  clear which inbox you're viewing. Omitted in demo mode. */
  mailboxEmail?: string | null;
  /** Every mailbox added to this install — turns the identity block into a switcher. */
  accounts?: string[];
  onSwitchMailbox?: (email: string) => void;
  onAddMailbox?: () => void;
  onRemoveMailbox?: (email: string) => void;
}) {
  const mail = useMemo<MailClient>(() => client ?? makeMailClient(), [client]);

  const [folder, setFolder] = useState<Folder>("inbox");
  const [items, setItems] = useState<MessageMeta[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MessageMeta | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedBody | null>(null);
  const [allowImages, setAllowImages] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composeInit, setComposeInit] = useState<ComposeInit | null>(null);
  // Fallback when the OS can't auto-open a download (e.g. a Tauri build whose
  // opener plugin isn't active yet): surface the link so the user is never stuck.
  const [attachmentLink, setAttachmentLink] = useState<{ url: string; filename: string } | null>(null);
  // In-app attachment preview (images + PDFs) — rendered in a modal, so nothing
  // bounces out to a browser window. Images use a blob URL (revoked on close);
  // PDFs are rasterised from the bytes by pdf.js (the webview's own PDF plugin
  // doesn't run in the sandboxed container iframe).
  const [preview, setPreview] = useState<{ url: string | null; name: string; kind: "image" | "pdf"; bytes: Uint8Array; contentType: string } | null>(null);
  // Which attachment is being fetched/decrypted right now (spinner on its chip).
  const [attBusy, setAttBusy] = useState<number | null>(null);
  // "Saved to Downloads" confirmation, auto-dismissed.
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  // One-time security note explaining SES's built-in virus/spam scanning.
  const [scanNoteDismissed, setScanNoteDismissed] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem("mailpoppy.scanNoteDismissed") === "1",
  );
  const [securityOpen, setSecurityOpen] = useState(false);
  const [usage, setUsage] = useState<MailboxUsage | null>(null);

  async function loadUsage() {
    try {
      setUsage(await mail.getUsage());
    } catch {
      setUsage(null); // usage is informational; never block the inbox on it
    }
  }
  useEffect(() => {
    void loadUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mail]);

  function startReply(mode: ReplyMode) {
    if (!selected) return;
    setComposeInit(buildReply(selected, mode, { self: selected.mailbox, quotedBody: parsed?.text ?? selected.snippet }));
  }

  // Cache identity: which mailbox the persisted list caches belong to. Demo mode
  // has no stable identity, so it never caches.
  const cacheId = !demo && mailboxEmail ? mailboxEmail : null;

  // Latest folder/client, so an in-flight response can tell whether it's still
  // wanted. Without this, switching folders mid-fetch let the OLD folder's reply
  // land in (and get cached for) the NEW folder.
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const mailRef = useRef(mail);
  mailRef.current = mail;

  // `background` refreshes (polling / window-focus / cache revalidation) stay silent:
  // no spinner, and a transient failure never replaces a working list with an error.
  async function refresh(f: Folder = folder, opts: { background?: boolean } = {}) {
    if (!opts.background) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await mail.list({ folder: f, limit: 100 });
      if (folderRef.current !== f || mailRef.current !== mail) return; // stale response — drop it
      setItems(res.items);
      if (cacheId) saveListCache(cacheId, f, res.items);
      if (opts.background) setError(null); // a good poll clears a stale transient error
    } catch (e) {
      if (!opts.background) setError(friendlyError(e));
    } finally {
      if (!opts.background) setLoading(false);
    }
  }

  // Reload whenever the folder changes. A cached list renders instantly (no spinner)
  // and a silent refresh replaces it — the mobile app's stale-while-revalidate.
  useEffect(() => {
    setSelected(null);
    setRaw(null);
    setParsed(null);
    setQuery("");
    const cached = cacheId ? loadListCache(cacheId, folder) : null;
    if (cached) {
      setItems(cached);
      setError(null);
      void refresh(folder, { background: true });
    } else {
      setItems([]); // never show the previous folder's rows under the spinner
      void refresh(folder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, mail]);

  // Keep the open folder live: poll on an interval and whenever the window
  // regains focus, so newly-arrived mail appears without switching folders.
  // Background refreshes are silent and only replace the list — the message
  // you're currently reading is left untouched.
  useEffect(() => {
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return; // skip a hidden window
      void refresh(folder, { background: true });
    };
    const id = window.setInterval(poll, 30_000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, mail]);

  async function open(m: MessageMeta) {
    setSelected(m);
    setRaw(null);
    setParsed(null);
    setAllowImages(false); // re-block remote content for each newly opened message
    setShowRaw(false);
    setAttachmentLink(null);

    // Delivered mail is immutable, so a cached body needs no network and no decrypt.
    // Drafts are NOT immutable (editable elsewhere) — always fetched fresh.
    const cacheable = folder !== "drafts";
    let eml = cacheable ? loadCachedEml(m.messageId) : null;
    if (eml === null) {
      try {
        ({ eml } = await mail.getRaw(m.messageId));
        // Encrypted mail comes back as ciphertext — decrypt with the cached mailbox
        // key before parsing/displaying (a no-op for mail stored in clear).
        eml = await decryptEml(m, eml);
        if (cacheable) saveCachedEml(m.messageId, eml);
      } catch (e) {
        setError(friendlyError(e));
        return;
      }
    }
    setRaw(eml);

    // Mark read immediately — independent of (and not blocked by) body parsing.
    if (m.flags.unread) {
      try {
        await mail.setFlags(m.messageId, { unread: false });
        setItems((prev) => prev.map((x) => (x.messageId === m.messageId ? { ...x, flags: { ...x.flags, unread: false } } : x)));
        setSelected((s) => (s ? { ...s, flags: { ...s.flags, unread: false } } : s));
      } catch (e) {
        setError(friendlyError(e));
      }
    }

    // Body parsing is best-effort: a parse failure just falls back to the raw view.
    try {
      setParsed(await parseBody(eml));
    } catch {
      setParsed(null);
    }
  }

  /** Attachment types the app can render itself, keyed off content-type + extension. */
  function previewKind(att: { filename: string; contentType?: string }): "image" | "pdf" | null {
    const ct = (att.contentType ?? "").toLowerCase();
    const name = att.filename.toLowerCase();
    if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return "image";
    if (ct === "application/pdf" || name.endsWith(".pdf")) return "pdf";
    return null;
  }

  /** The attachment's actual bytes: fetched from the presigned URL and, for
   *  encrypted mail, decrypted here with the cached mailbox key. */
  async function fetchAttachmentBytes(messageId: string, index: number): Promise<Uint8Array> {
    const { url } = await mail.getAttachmentUrl(messageId, index);
    if (selected?.encrypted) {
      const ciphertext = await (await fetch(url)).text();
      return decryptAttachmentBytes(selected, ciphertext);
    }
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }

  /** Save bytes into ~/Downloads (no browser window); falls back to the browser
   *  handoff on an old sidecar, and to a manual link if even that can't open. */
  async function saveAttachment(filename: string, contentType: string, bytes: Uint8Array) {
    const out = await saveBytesToDownloads(filename, contentType, bytes);
    if (out.savedAs) {
      setSaveNotice(out.savedAs);
      window.setTimeout(() => setSaveNotice((cur) => (cur === out.savedAs ? null : cur)), 6000);
    } else if (out.url && !out.opened) {
      setAttachmentLink({ url: out.url, filename });
    }
  }

  /** Open an attachment: preview images/PDFs in-app, save everything else. */
  async function openAttachment(messageId: string, index: number, att: { filename: string; contentType?: string }) {
    setAttachmentLink(null);
    setSaveNotice(null);
    setAttBusy(index);
    try {
      const bytes = await fetchAttachmentBytes(messageId, index);
      const contentType = att.contentType ?? "application/octet-stream";
      const kind = previewKind(att);
      if (kind) {
        // Only images need a blob URL; PDFs render straight from the bytes.
        const url = kind === "image" ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType })) : null;
        setPreview({ url, name: att.filename, kind, bytes, contentType });
      } else {
        await saveAttachment(att.filename, contentType, bytes);
      }
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setAttBusy(null);
    }
  }

  function closePreview() {
    setPreview((p) => {
      if (p?.url) URL.revokeObjectURL(p.url);
      return null;
    });
  }

  async function toggleRead(m: MessageMeta) {
    const next = !m.flags.unread;
    await mail.setFlags(m.messageId, { unread: next });
    setItems((prev) => prev.map((x) => (x.messageId === m.messageId ? { ...x, flags: { ...x.flags, unread: next } } : x)));
  }

  async function toggleStar(m: MessageMeta) {
    const next = !m.flags.starred;
    await mail.setFlags(m.messageId, { starred: next });
    setItems((prev) => prev.map((x) => (x.messageId === m.messageId ? { ...x, flags: { ...x.flags, starred: next } } : x)));
  }

  async function moveTo(m: MessageMeta, dest: Folder) {
    await mail.move(m.messageId, dest);
    setItems((prev) => prev.filter((x) => x.messageId !== m.messageId));
    if (selected?.messageId === m.messageId) {
      setSelected(null);
      setRaw(null);
    }
  }

  const unreadCount = items.filter((m) => m.flags.unread).length;
  const visible = filterMessages(items, query);
  const wide = useIsWide();

  const goBackToList = () => {
    setSelected(null);
    setRaw(null);
    setParsed(null);
  };

  // The signed-in mailbox identity (folder rail, wide layout) — a switcher when
  // several mailboxes are added.
  const signedIn = mailboxEmail ? (
    <div className="border-b border-outline-variant/10">
      <MailboxIdentity
        mailboxEmail={mailboxEmail}
        accounts={accounts}
        onSwitch={onSwitchMailbox}
        onAdd={onAddMailbox}
        onRemove={onRemoveMailbox}
      />
    </div>
  ) : null;

  // Vertical folder rail (wide layout).
  const folderRail = (
    <nav aria-label="Folders" className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
      <div className="mb-1 ml-2 mt-1 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Mailbox</div>
      {FOLDERS.map((f) => {
        const active = f === folder;
        const Icon = FOLDER_ICON[f] ?? Mail;
        const count = f === "inbox" ? unreadCount : 0;
        return (
          <button
            key={f}
            onClick={() => setFolder(f)}
            aria-current={active}
            className={cn(
              "flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "border border-primary/10 bg-primary-container/10 font-medium text-primary"
                : "text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
            )}
          >
            <span className="flex items-center gap-3">
              <Icon className="size-4" />
              {FOLDER_LABEL[f] ?? f}
            </span>
            {count > 0 && (
              <span className="rounded bg-primary/20 px-1.5 py-0.5 font-mono text-xs text-primary">{count}</span>
            )}
          </button>
        );
      })}

      <div className="mb-1 ml-2 mt-6 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">Tools</div>
      <button
        onClick={() => setSecurityOpen(true)}
        title="How your email is protected"
        className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
      >
        <ShieldCheck className="size-4 text-tertiary" />
        Security
      </button>

      {usage && <StorageMeter usage={usage} />}
    </nav>
  );

  // Horizontal folder chips (narrow layout).
  const folderChips = (
    <div className="flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Folders">
      {FOLDERS.map((f) => {
        const active = f === folder;
        const Icon = FOLDER_ICON[f] ?? Mail;
        const count = f === "inbox" ? unreadCount : 0;
        return (
          <button
            key={f}
            onClick={() => setFolder(f)}
            aria-current={active}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
              active
                ? "border-primary/20 bg-primary-container/15 font-medium text-primary"
                : "border-outline-variant/20 text-on-surface-variant hover:bg-surface-container hover:text-on-surface",
            )}
          >
            <Icon className="size-4" />
            {FOLDER_LABEL[f] ?? f}
            {count > 0 && <span className="rounded bg-primary/20 px-1.5 font-mono text-xs text-primary">{count}</span>}
          </button>
        );
      })}
    </div>
  );

  // Search box + message list (shared by both layouts).
  const messageList = (
    <>
      <div className="border-b border-outline-variant/10 p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" />
            <input
              aria-label="Search messages"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${FOLDER_LABEL[folder] ?? folder}…`}
              className="w-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest py-1.5 pl-8 pr-3 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus:border-primary/50 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void refresh(folder)}
            disabled={loading}
            aria-label="Refresh"
            title="Check for new mail"
            className="shrink-0 rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-2 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
        </div>
      </div>
      <div className="flex-1 divide-y divide-outline-variant/10 overflow-y-auto">
        {loading && (
          <p className="flex items-center gap-2 p-4 text-sm text-on-surface-variant">
            <Spinner /> Loading…
          </p>
        )}
        {error && <p className="p-4 text-sm text-tertiary">{error}</p>}
        {!loading && !error && items.length === 0 && (
          <p className="p-4 text-sm text-on-surface-variant">No messages in {FOLDER_LABEL[folder] ?? folder}.</p>
        )}
        {!loading && !error && items.length > 0 && visible.length === 0 && (
          <p className="p-4 text-sm text-on-surface-variant">No messages match “{query}”.</p>
        )}
        {visible.map((m) => {
          const active = selected?.messageId === m.messageId;
          const unread = m.flags.unread;
          return (
            <button
              key={m.messageId}
              onClick={() => void open(m)}
              aria-label={`Open: ${m.subject}`}
              className={cn(
                "block w-full border-l-2 p-4 text-left transition-colors hover:bg-surface-container",
                active ? "border-l-primary bg-primary/10" : unread ? "border-l-primary bg-primary/5" : "border-l-transparent",
              )}
            >
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className={cn("flex items-center gap-1 truncate", unread ? "font-bold text-on-surface" : "text-on-surface-variant")}>
                  {m.flags.starred && <Star className="size-3.5 shrink-0 fill-warn text-warn" />}
                  {fromLabel(m)}
                </span>
                <span className={cn("shrink-0 whitespace-nowrap font-mono text-xs", unread ? "text-primary" : "text-on-surface-variant")}>
                  {shortDate(m.date)}
                </span>
              </div>
              <div className={cn("mb-1 flex items-center gap-1 truncate text-sm", unread ? "font-semibold text-on-surface" : "text-on-surface")}>
                {m.encrypted && (
                  <Lock className="size-3.5 shrink-0 text-secondary" aria-label="Encrypted at rest">
                    <title>Encrypted at rest</title>
                  </Lock>
                )}
                {m.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-on-surface-variant" />}
                {m.subject}
              </div>
              <div className="truncate text-xs text-on-surface-variant/70">{m.snippet}</div>
            </button>
          );
        })}
      </div>
    </>
  );

  // "No message selected" placeholder (wide layout only).
  const emptyReading = (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="mb-6 flex size-16 items-center justify-center rounded-2xl border border-outline-variant/10 bg-surface-container shadow-inner">
        <Mail className="size-8 text-on-surface-variant/50" />
      </div>
      <h2 className="mb-2 text-2xl font-semibold text-on-surface">No message selected</h2>
      <p className="max-w-sm text-on-surface-variant">Select a message from the list to read it, or compose a new one.</p>
    </div>
  );

  // The open message: header, security/verdicts, attachments, actions, body
  // (shared by both layouts; gets the full width in the narrow layout).
  const readingArticle = selected ? (
    <article className="flex-1 overflow-y-auto p-6">
      <h3 className="mb-1 text-xl font-semibold text-on-surface">{selected.subject}</h3>
      <div className="text-sm text-on-surface-variant">
        From <strong className="text-on-surface">{fromLabel(selected)}</strong>{" "}
        <span className="font-mono text-xs">&lt;{selected.from.address}&gt;</span>
      </div>
      <div className="text-xs text-on-surface-variant/80">
        To {selected.to.map((t) => t.address).join(", ")} · {shortDate(selected.date)}
      </div>

      {selected.encrypted && (
        <div
          title="Body and attachments are stored encrypted in S3 with this mailbox's key. Even the AWS account admin can't read them — they're decrypted here, on your device."
          className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-secondary/30 bg-secondary/10 px-2.5 py-1 text-xs font-medium text-secondary"
        >
          <Lock className="size-3.5" /> Encrypted at rest
        </div>
      )}

      {selected.verdicts && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-on-surface-variant">
          <span
            title="Antivirus scan result from AWS SES. Virus-positive mail is quarantined and never delivered to the inbox."
            className={cn(
              "inline-flex items-center gap-1",
              selected.verdicts.virus === "PASS" ? "text-secondary" : selected.verdicts.virus === "FAIL" ? "text-tertiary" : "text-on-surface-variant",
            )}
          >
            <ShieldQuestion className="size-3.5" /> virus {selected.verdicts.virus}
          </span>
          <span>· SPF {selected.verdicts.spf} · DKIM {selected.verdicts.dkim} · DMARC {selected.verdicts.dmarc} · spam {selected.verdicts.spam}</span>
        </div>
      )}

      {selected.attachments && selected.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {selected.attachments.map((a, i) => (
            <button
              key={`${a.filename}-${i}`}
              onClick={() => void openAttachment(selected.messageId, i, a)}
              disabled={attBusy !== null}
              title={previewKind(a) ? "Preview" : "Save to Downloads"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-outline-variant/30 bg-surface-container px-3 py-1.5 text-xs text-on-surface transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-60"
            >
              <Paperclip className="size-3.5" /> {a.filename} ({Math.max(1, Math.round(a.sizeBytes / 1024))} KB)
              {attBusy === i ? <Spinner /> : previewKind(a) ? <Eye className="size-3.5" /> : <Download className="size-3.5" />}
            </button>
          ))}
        </div>
      )}

      {saveNotice && (
        <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-secondary/30 bg-secondary/10 px-3 py-2 text-sm text-secondary">
          <CheckCircle2 className="size-4" /> Saved to Downloads: <strong>{saveNotice}</strong>
        </div>
      )}

      {attachmentLink && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn-bright">
          <div>
            Couldn’t open <strong>{attachmentLink.filename}</strong> automatically. Click below, or copy this link into
            your browser to download it (the link is valid for 5 minutes):
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void openExternal(attachmentLink.url)}>
              <ExternalLink className="size-3.5" /> Open in browser
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(attachmentLink.url)}>
              <Copy className="size-3.5" /> Copy link
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAttachmentLink(null)}>
              Dismiss
            </Button>
          </div>
          <input
            readOnly
            value={attachmentLink.url}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-2 w-full rounded border border-outline-variant/30 bg-surface-container-lowest p-1.5 font-mono text-[11px] text-on-surface-variant"
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-outline-variant/10 pt-4">
        <Button size="sm" variant="secondary" onClick={() => startReply("reply")}>
          <ReplyIcon className="size-4" /> Reply
        </Button>
        {selected.to.length > 1 && (
          <Button size="sm" variant="secondary" onClick={() => startReply("replyAll")}>
            <ReplyAll className="size-4" /> Reply all
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => startReply("forward")}>
          <Forward className="size-4" /> Forward
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void toggleRead(selected)}>
          <MailOpen className="size-4" /> {selected.flags.unread ? "Mark read" : "Mark unread"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void toggleStar(selected)}>
          <Star className="size-4" /> {selected.flags.starred ? "Unstar" : "Star"}
        </Button>
        {folder !== "trash" ? (
          <Button size="sm" variant="ghost" aria-label="Move to Trash" onClick={() => void moveTo(selected, "trash")}>
            <Trash2 className="size-4" /> Trash
          </Button>
        ) : (
          <Button size="sm" variant="ghost" aria-label="Restore to Inbox" onClick={() => void moveTo(selected, "inbox")}>
            <Undo2 className="size-4" /> Restore to Inbox
          </Button>
        )}
      </div>

      <MessageBody
        parsed={parsed}
        raw={raw}
        allowImages={allowImages}
        onLoadImages={() => setAllowImages(true)}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((v) => !v)}
      />
    </article>
  ) : null;

  // Floating "scanned & verified" reassurance (wide layout only).
  const footerBadge = (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <div className="flex items-center gap-2 rounded-full border border-outline-variant/20 bg-surface-container/80 px-3 py-1.5">
        <ShieldCheck className="size-3.5 text-secondary" />
        <span className="font-mono text-[11px] text-on-surface-variant">Incoming mail scanned &amp; verified by AWS SES</span>
      </div>
    </div>
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      {demo && (
        <div className="flex shrink-0 items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm text-warn-bright">
          <span>
            🧪 <strong className="font-semibold">Demo data</strong> — not connected to a live mailbox.
          </span>
          {onConnect && (
            <Button size="sm" variant="secondary" onClick={onConnect}>
              Connect a deployment
            </Button>
          )}
        </div>
      )}

      <SecurityInfo open={securityOpen} onClose={() => setSecurityOpen(false)} />

      {!demo && !scanNoteDismissed && (
        <div className="flex shrink-0 items-start justify-between gap-3 rounded-lg border border-secondary/30 bg-secondary/10 px-4 py-2.5 text-sm">
          <span className="text-secondary/90">
            🛡 <strong className="font-semibold">Incoming mail is automatically scanned for viruses and spam by AWS SES.</strong>{" "}
            A message that fails the virus check is quarantined to Junk and never reaches your inbox. Each message shows its
            scan result (virus / SPF / DKIM / DMARC / spam). Note: this is AWS's built-in scan — it's not a substitute for
            your own device antivirus when you download a file.
          </span>
          <button
            onClick={() => {
              try {
                localStorage.setItem("mailpoppy.scanNoteDismissed", "1");
              } catch {
                /* ignore */
              }
              setScanNoteDismissed(true);
            }}
            className="shrink-0 whitespace-nowrap rounded px-2 py-1 text-secondary hover:bg-secondary/10"
          >
            Got it
          </button>
        </div>
      )}

      {wide ? (
        /* Three-pane inbox (room to spare). */
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-low shadow-lg">
          {/* Pane 1 — folders & actions */}
          <div className="flex w-60 shrink-0 flex-col border-r border-outline-variant/20 bg-surface-container-lowest/60">
            {signedIn}
            <div className="border-b border-outline-variant/10 p-4">
              <Button className="w-full" onClick={() => setComposeInit({ to: [], subject: "", text: "" })}>
                <PenSquare className="size-4" />
                Compose
              </Button>
            </div>
            {folderRail}
          </div>

          {/* Pane 2 — message list */}
          <div className="flex w-80 shrink-0 flex-col border-r border-outline-variant/20 bg-surface-container-low">
            {messageList}
          </div>

          {/* Pane 3 — reading / preview */}
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-container-lowest">
            {selected ? readingArticle : emptyReading}
            {footerBadge}
          </div>
        </div>
      ) : (
        /* Single-column inbox (narrow / inside AgentsPoppy): list ↔ message, like
           the mobile app, so the body always gets the full width. */
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-low shadow-lg">
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col bg-surface-container-lowest">
              <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant/10 p-2">
                <Button size="sm" variant="ghost" onClick={goBackToList}>
                  <ChevronLeft className="size-4" /> Back
                </Button>
              </div>
              {readingArticle}
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-col gap-2 border-b border-outline-variant/10 p-3">
                <div className="flex items-center gap-2">
                  {mailboxEmail && (
                    <MailboxIdentity
                      compact
                      mailboxEmail={mailboxEmail}
                      accounts={accounts}
                      onSwitch={onSwitchMailbox}
                      onAdd={onAddMailbox}
                      onRemove={onRemoveMailbox}
                    />
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => setSecurityOpen(true)}
                      title="How your email is protected"
                      aria-label="Security"
                      className="rounded-lg border border-outline-variant/20 p-2 text-on-surface-variant hover:text-on-surface"
                    >
                      <ShieldCheck className="size-4 text-tertiary" />
                    </button>
                    <Button size="sm" onClick={() => setComposeInit({ to: [], subject: "", text: "" })}>
                      <PenSquare className="size-4" /> Compose
                    </Button>
                  </div>
                </div>
                {folderChips}
              </div>
              {messageList}
            </div>
          )}
        </div>
      )}

      {preview && (
        <AttachmentPreview
          name={preview.name}
          url={preview.url}
          kind={preview.kind}
          bytes={preview.bytes}
          onSave={() => void saveAttachment(preview.name, preview.contentType, preview.bytes)}
          saveNotice={saveNotice}
          onClose={closePreview}
        />
      )}

      {composeInit && (
        <ComposeDialog
          init={composeInit}
          onClose={() => setComposeInit(null)}
          onSend={async (input) => {
            await mail.send(input);
            setComposeInit(null);
            setFolder("sent");
            await refresh("sent");
          }}
        />
      )}
    </section>
  );
}

/**
 * The signed-in identity — and, when the install has (or can add) more mailboxes,
 * a dropdown switcher: pick a mailbox to jump to it, remove one, or add another.
 * Mirrors the mobile app's switcher so both clients feel the same.
 */
function MailboxIdentity({
  mailboxEmail,
  accounts,
  onSwitch,
  onAdd,
  onRemove,
  compact,
}: {
  mailboxEmail: string;
  accounts?: string[];
  onSwitch?: (email: string) => void;
  onAdd?: () => void;
  onRemove?: (email: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const interactive = Boolean(onSwitch || onAdd);

  const identity = compact ? (
    <span className="flex min-w-0 items-center gap-1.5" title={mailboxEmail}>
      <AtSign className="size-4 shrink-0 text-primary" />
      <span className="truncate text-xs font-medium text-on-surface">{mailboxEmail}</span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-2.5" title={mailboxEmail}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-container/20 text-primary">
        <AtSign className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">Signed in as</span>
        <span className="block truncate text-sm font-medium text-on-surface">{mailboxEmail}</span>
      </span>
    </span>
  );

  if (!interactive) {
    return <div className={compact ? "flex min-w-0 items-center" : "flex items-center px-4 py-3"}>{identity}</div>;
  }

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        aria-label="Switch mailbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 text-left transition-colors hover:bg-surface-container",
          compact ? "rounded-lg px-1.5 py-1" : "px-4 py-3",
        )}
      >
        {identity}
        <ChevronDown className={cn("size-3.5 shrink-0 text-on-surface-variant transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container py-1 shadow-2xl">
          {(accounts ?? [mailboxEmail]).map((email) => {
            const active = email === mailboxEmail;
            return (
              <div key={email} className="flex items-center">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!active) onSwitch?.(email);
                  }}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-container-highest",
                    active ? "font-medium text-on-surface" : "text-on-surface-variant",
                  )}
                >
                  <Check className={cn("size-3.5 shrink-0", active ? "text-primary" : "opacity-0")} />
                  <span className="truncate">{email}</span>
                </button>
                {onRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${email}`}
                    title="Remove this mailbox from the app (its mail stays on the server)"
                    onClick={() => {
                      setOpen(false);
                      onRemove(email);
                    }}
                    className="mr-1.5 rounded p-1.5 text-on-surface-variant/60 hover:bg-surface-container-highest hover:text-tertiary"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          {onAdd && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
              className="mt-1 flex w-full items-center gap-2 border-t border-outline-variant/10 px-3 py-2 text-left text-sm text-primary transition-colors hover:bg-surface-container-highest"
            >
              <Plus className="size-3.5" /> Add mailbox
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Full-screen in-app viewer for image/PDF attachments — no browser bounce.
 *  Images use a blob URL (created/revoked by the caller); PDFs are rasterised
 *  from the bytes by pdf.js, since the webview's own PDF plugin doesn't run in
 *  the sandboxed container iframe (it rendered a blank page). */
function AttachmentPreview({
  name,
  url,
  kind,
  bytes,
  onSave,
  saveNotice,
  onClose,
}: {
  name: string;
  url: string | null;
  kind: "image" | "pdf";
  bytes: Uint8Array;
  onSave: () => void;
  saveNotice: string | null;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={`Preview: ${name}`}
      className="fixed inset-0 z-50 flex flex-col bg-base/90"
      onClick={onClose}
    >
      <div
        className="flex shrink-0 items-center gap-3 border-b border-outline-variant/20 bg-surface-container px-4 py-2.5"
        onClick={(e) => e.stopPropagation()}
      >
        <Paperclip className="size-4 shrink-0 text-on-surface-variant" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-on-surface">{name}</span>
        {saveNotice && (
          <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
            <CheckCircle2 className="size-3.5" /> Saved to Downloads
          </span>
        )}
        <Button size="sm" variant="secondary" onClick={onSave}>
          <Download className="size-3.5" /> Save to Downloads
        </Button>
        <Button size="sm" variant="ghost" aria-label="Close preview" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        {kind === "image" && url ? (
          // eslint-disable-next-line jsx-a11y/img-redundant-alt
          <img src={url} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        ) : (
          <PdfViewer bytes={bytes} />
        )}
      </div>
    </div>
  );
}

/** Per-mailbox storage meter shown at the foot of the folder rail. */
function StorageMeter({ usage }: { usage: MailboxUsage }) {
  const pct = usagePercent(usage.usedBytes, usage.quotaBytes);
  const level = usageLevel(usage.usedBytes, usage.quotaBytes);
  const barClass = level === "full" ? "bg-tertiary-container" : level === "warn" ? "bg-warn" : "bg-primary";
  const textClass = level === "full" ? "text-tertiary" : level === "warn" ? "text-warn" : "text-primary";
  return (
    <div aria-label="Mailbox storage" className="mt-auto px-2 pt-4 text-xs text-on-surface-variant">
      {usage.quotaBytes && pct !== null ? (
        <>
          <div className="flex justify-between">
            <span>Storage</span>
            <span className={textClass}>{Math.round(pct)}%</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-container-highest">
            <div className={cn("h-full", barClass)} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="mt-1 text-on-surface-variant/70">
            {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
          </div>
          {level === "full" && <div className="mt-0.5 text-tertiary">Full — new mail is bounced.</div>}
          {level === "warn" && <div className="mt-0.5 text-warn">Almost full.</div>}
        </>
      ) : (
        <div>Storage: {formatBytes(usage.usedBytes)} used</div>
      )}
    </div>
  );
}

function MessageBody({
  parsed,
  raw,
  allowImages,
  onLoadImages,
  showRaw,
  onToggleRaw,
}: {
  parsed: ParsedBody | null;
  raw: string | null;
  allowImages: boolean;
  onLoadImages: () => void;
  showRaw: boolean;
  onToggleRaw: () => void;
}) {
  const sanitized = useMemo(
    () => (parsed?.html ? sanitizeHtml(parsed.html, { allowRemoteImages: allowImages }) : null),
    [parsed, allowImages],
  );

  if (!parsed && !raw) return <p className="mt-3 text-on-surface-variant/70">Loading message…</p>;

  const preClass =
    "mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-lg border border-outline-variant/10 bg-surface-container-lowest p-3 font-mono text-[13px] text-on-surface";

  return (
    <div className="mt-4">
      <div className="flex justify-end">
        <button onClick={onToggleRaw} className="text-xs text-primary underline-offset-2 hover:underline">
          {showRaw ? "View formatted" : "View raw source"}
        </button>
      </div>

      {showRaw ? (
        <pre className={preClass}>{raw}</pre>
      ) : sanitized ? (
        <>
          {sanitized.blockedRemote && !allowImages && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-1.5 text-sm text-warn-bright">
              <span className="inline-flex items-center gap-2">
                <ImageOff className="size-4" /> Remote images blocked to protect your privacy.
              </span>
              <Button size="sm" variant="secondary" onClick={onLoadImages}>
                Load images
              </Button>
            </div>
          )}
          {/* Safe: HTML is sanitized by DOMPurify (lib/mailBody.ts) before it reaches the DOM. */}
          <div
            className="mt-2 overflow-x-auto rounded-lg border border-outline-variant/10 bg-paper p-3 text-on-paper"
            dangerouslySetInnerHTML={{ __html: sanitized.clean }}
          />
        </>
      ) : (
        <pre className={preClass}>{parsed?.text ?? raw}</pre>
      )}
    </div>
  );
}

function ComposeDialog({
  init,
  onClose,
  onSend,
}: {
  init: ComposeInit;
  onClose: () => void;
  onSend: (input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    text: string;
    html?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: SendAttachment[];
  }) => Promise<void>;
}) {
  const [to, setTo] = useState(init.to.join(", "));
  const [cc, setCc] = useState((init.cc ?? []).join(", "));
  const [bcc, setBcc] = useState((init.bcc ?? []).join(", "));
  // Cc/Bcc stay collapsed until asked for (or prefilled) — most mail needs neither.
  const [showCcBcc, setShowCcBcc] = useState(Boolean(init.cc?.length || init.bcc?.length));
  const [subject, setSubject] = useState(init.subject);
  const [text, setText] = useState(init.text);
  const [preview, setPreview] = useState(false);
  const [attachments, setAttachments] = useState<SendAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    try {
      const added = await filesToAttachments(files);
      setAttachments((prev) => [...prev, ...added]);
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  async function submit() {
    setSending(true);
    setErr(null);
    try {
      const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const recipients = parseList(to);
      if (recipients.length === 0) throw new Error("Add at least one recipient");
      const ccList = parseList(cc);
      const bccList = parseList(bcc);
      // Send a formatted HTML body (rendered from Markdown) + a plaintext fallback.
      const html = text.trim() ? renderMarkdown(text) : undefined;
      await onSend({
        to: recipients,
        cc: ccList.length ? ccList : undefined,
        bcc: bccList.length ? bccList : undefined,
        subject,
        text,
        html,
        inReplyTo: init.inReplyTo,
        references: init.references,
        attachments: attachments.length ? attachments : undefined,
      });
    } catch (e) {
      setErr(friendlyError(e));
      setSending(false);
    }
  }

  const fieldLabel = "mb-1 block text-sm text-on-surface-variant";
  const fieldInput =
    "w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <div
      role="dialog"
      aria-label="Compose message"
      className="fixed inset-0 z-50 flex items-center justify-center bg-base/80 p-4"
    >
      <div className="w-[480px] max-w-[90vw] rounded-xl border border-outline-variant/20 bg-surface-container p-6 shadow-2xl">
        <h3 className="mb-3 text-lg font-semibold text-on-surface">{init.inReplyTo ? "Reply" : "New message"}</h3>
        <div className="flex items-baseline justify-between">
          <label className={fieldLabel}>To (comma-separated)</label>
          {!showCcBcc && (
            <button
              type="button"
              onClick={() => setShowCcBcc(true)}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              Cc / Bcc
            </button>
          )}
        </div>
        <input aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} placeholder="alice@example.com" className={cn(fieldInput, "mb-3")} />
        {showCcBcc && (
          <>
            <label className={fieldLabel}>Cc</label>
            <input aria-label="Cc" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="copy@example.com" className={cn(fieldInput, "mb-3")} />
            <label className={fieldLabel}>Bcc</label>
            <input aria-label="Bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} placeholder="hidden@example.com" className={cn(fieldInput, "mb-3")} />
          </>
        )}
        <label className={fieldLabel}>Subject</label>
        <input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className={cn(fieldInput, "mb-3")} />
        <div className="flex items-baseline justify-between">
          <label className={fieldLabel}>
            Message <span className="text-on-surface-variant/60">· Markdown supported</span>
          </label>
          <button type="button" onClick={() => setPreview((v) => !v)} className="text-xs text-primary underline-offset-2 hover:underline">
            {preview ? "Edit" : "Preview"}
          </button>
        </div>
        {preview ? (
          <div
            aria-label="Preview"
            className="min-h-[120px] rounded-lg border border-outline-variant/30 bg-paper p-2 text-on-paper"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        ) : (
          <textarea aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} rows={6} className={cn(fieldInput, "resize-y")} />
        )}

        <div className="mt-3">
          <input aria-label="Attach files" type="file" multiple onChange={(e) => void onFiles(e.target.files)} className="text-xs text-on-surface-variant file:mr-3 file:rounded-md file:border-0 file:bg-surface-container-highest file:px-3 file:py-1.5 file:text-on-surface" />
          {attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {attachments.map((a, i) => (
                <span key={`${a.filename}-${i}`} className="inline-flex items-center gap-1 rounded-md bg-surface-container-highest px-2 py-1 text-xs text-on-surface">
                  <Paperclip className="size-3" /> {a.filename}
                  <button
                    aria-label={`Remove ${a.filename}`}
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-1 text-tertiary hover:text-tertiary-container"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={sending}>
            {sending ? <Spinner className="border-white/40 border-t-white" /> : <Send className="size-4" />}
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
