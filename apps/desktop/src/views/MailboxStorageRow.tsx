import { useEffect, useState } from "react";
import { formatBytes, usagePercent, usageLevel } from "@mailpoppy/core";
import { getMailboxStorage, setMailboxQuota, type MailboxStorageInfo } from "../lib/mailboxStorage";
import {
  deleteMailbox as defaultDelete,
  resetMailboxPassword as defaultReset,
  type MailboxDeletion,
} from "../lib/mailbox";
import type { getAgentOwned, setAgentOwned } from "../lib/mailboxAgent";
import { AgentOwnedToggle } from "./AgentOwnedToggle";
import { Button, cn } from "../ui";
import { friendlyError } from "../lib/errors";

// One row in the Mailboxes list: shows a mailbox's storage usage ("X of Y (Z%)")
// and lets the admin set or clear its storage limit, or permanently delete the
// mailbox. Fetches its own usage so the parent list stays simple. The load/save/
// delete calls are injectable so the row can be unit-tested without a sidecar.

const GB = 1024 ** 3;

// Deleting a mailbox is destructive + irreversible, so (per the teardown
// pattern) we require the admin to type this exact word to arm the button.
const CONFIRM_WORD = "delete";

const smallInput =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-2 py-1.5 text-sm text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
const linkBtn = "text-xs text-primary underline-offset-2 hover:underline";

export function MailboxStorageRow({
  email,
  status,
  stackName,
  loadStorage = getMailboxStorage,
  saveQuota = setMailboxQuota,
  del = defaultDelete,
  resetPw = defaultReset,
  loadAgent,
  saveAgent,
  onDeleted,
  onOpenInbox,
}: {
  email: string;
  status?: string;
  stackName: string;
  loadStorage?: (stackName: string, email: string) => Promise<MailboxStorageInfo>;
  saveQuota?: typeof setMailboxQuota;
  del?: (input: { email: string; stackName?: string }) => Promise<MailboxDeletion>;
  resetPw?: (input: { email: string; password: string; stackName?: string }) => Promise<{ ok: true; email: string }>;
  loadAgent?: typeof getAgentOwned;
  saveAgent?: typeof setAgentOwned;
  onDeleted?: (email: string) => void;
  onOpenInbox?: (email: string) => void;
}) {
  const [info, setInfo] = useState<MailboxStorageInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [gb, setGb] = useState("");
  const [busy, setBusy] = useState(false);

  // Delete flow
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  // Reset-password flow
  const [resetOpen, setResetOpen] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);

  async function load() {
    setErr(null);
    try {
      const i = await loadStorage(stackName, email);
      setInfo(i);
      setGb(i.quotaBytes ? String(+(i.quotaBytes / GB).toFixed(2)) : "");
    } catch (e) {
      setErr(friendlyError(e));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, stackName]);

  async function save(clear: boolean) {
    setErr(null);
    const quotaBytes = clear ? null : Math.round(parseFloat(gb) * GB);
    if (!clear && (!quotaBytes || quotaBytes <= 0)) {
      setErr("Enter a positive number of GB.");
      return;
    }
    setBusy(true);
    try {
      await saveQuota({ stackName, email, quotaBytes });
      setEditing(false);
      await load();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setDelErr(null);
    setDeleting(true);
    try {
      await del({ stackName, email });
      onDeleted?.(email);
      // Parent re-renders the list; no local state to reset on success.
    } catch (e) {
      setDelErr(friendlyError(e));
      setDeleting(false);
    }
  }

  async function doReset() {
    setPwErr(null);
    setPwDone(false);
    setPwBusy(true);
    try {
      await resetPw({ stackName, email, password: newPw });
      setPwDone(true);
      setNewPw("");
    } catch (e) {
      setPwErr(friendlyError(e));
    } finally {
      setPwBusy(false);
    }
  }

  const pct = info ? usagePercent(info.usedBytes, info.quotaBytes) : null;
  const level = info ? usageLevel(info.usedBytes, info.quotaBytes) : "ok";
  const barClass = level === "full" ? "bg-tertiary-container" : level === "warn" ? "bg-warn" : "bg-primary";
  const textClass = level === "full" ? "text-tertiary" : level === "warn" ? "text-warn" : "text-primary";
  const armed = confirmText.trim().toLowerCase() === CONFIRM_WORD;

  return (
    <li className="list-none rounded-lg border border-outline-variant/10 bg-surface-container-lowest/40 p-3">
      <div>
        <code className="font-mono text-sm text-on-surface">{email}</code>
        {status && <span className="text-xs text-on-surface-variant/70"> · {status}</span>}
        {info && (
          <span className="ml-2 text-xs text-on-surface-variant">
            {info.quotaBytes && pct !== null ? (
              <>
                · {formatBytes(info.usedBytes)} of {formatBytes(info.quotaBytes)} (<span className={textClass}>{Math.round(pct)}%</span>)
              </>
            ) : (
              <>· {formatBytes(info.usedBytes)} used · no limit</>
            )}
          </span>
        )}
      </div>
      {info?.quotaBytes && pct !== null && (
        <div className="mt-1 h-1.5 max-w-sm overflow-hidden rounded-full bg-surface-container-highest">
          <div className={cn("h-full", barClass)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}

      <div className="mt-2">
        {editing ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-on-surface">
            Limit
            <input
              aria-label={`Storage limit for ${email} in GB`}
              value={gb}
              onChange={(e) => setGb(e.target.value)}
              placeholder="e.g. 5"
              className={cn(smallInput, "w-20")}
            />
            GB
            <Button size="sm" variant="secondary" onClick={() => void save(false)} disabled={busy}>
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void save(true)} disabled={busy}>
              Remove limit
            </Button>
            <button onClick={() => setEditing(false)} disabled={busy} className="text-xs text-on-surface-variant hover:text-on-surface">
              Cancel
            </button>
          </span>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            {onOpenInbox && (
              <button
                onClick={() => onOpenInbox(email)}
                aria-label={`Open inbox for ${email}`}
                className={linkBtn}
              >
                Open inbox
              </button>
            )}
            <button onClick={() => setEditing(true)} className={linkBtn}>
              {info?.quotaBytes ? "Change storage limit" : "Set storage limit"}
            </button>
            {!resetOpen && (
              <button
                onClick={() => {
                  setResetOpen(true);
                  setNewPw("");
                  setPwErr(null);
                  setPwDone(false);
                }}
                className={linkBtn}
              >
                Reset password
              </button>
            )}
            {!confirming && (
              <button
                onClick={() => {
                  setConfirming(true);
                  setConfirmText("");
                  setDelErr(null);
                }}
                className="text-xs text-tertiary underline-offset-2 hover:underline"
              >
                Delete mailbox
              </button>
            )}
          </div>
        )}
      </div>

      {/* The CrewPoppy bridge: flag/unflag this mailbox as agent-owned. */}
      <AgentOwnedToggle email={email} stackName={stackName} load={loadAgent} save={saveAgent} />

      {resetOpen && (
        <div className="mt-2 max-w-xl rounded-lg border border-primary/20 bg-primary/5 p-3">
          <div className="text-sm leading-relaxed text-on-surface-variant">
            Set a new sign-in password for <b className="text-on-surface">{email}</b>. Use this to recover a mailbox your
            organization owns (e.g. an employee who has left) — afterwards you, or the user, can sign in with the new
            password. <b className="text-on-surface">Only do this for mailboxes you're authorised to access.</b>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-on-surface">
            New password
            <input
              aria-label={`New password for ${email}`}
              type="password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              disabled={pwBusy}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={cn(smallInput, "w-52")}
            />
          </div>
          <div className="mt-1 text-xs text-on-surface-variant/70">
            Min 8 characters, with upper &amp; lower case, a number and a symbol.
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={() => void doReset()} disabled={pwBusy || newPw.length < 8}>
              {pwBusy ? "Setting…" : "Set password"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setResetOpen(false);
                setNewPw("");
                setPwErr(null);
                setPwDone(false);
              }}
              disabled={pwBusy}
            >
              {pwDone ? "Close" : "Cancel"}
            </Button>
            {pwDone && <span className="text-sm text-secondary">✅ Password updated.</span>}
          </div>
          {pwErr && <div className="mt-1.5 text-xs text-tertiary">{pwErr}</div>}
        </div>
      )}

      {confirming && (
        <div className="mt-2 max-w-xl rounded-lg border border-tertiary/30 bg-tertiary-container/10 p-3">
          <div className="text-sm leading-relaxed text-tertiary">
            ⚠️ <b>Permanently delete {email}?</b> This removes the sign-in user <b>and all of its stored mail</b>
            {info ? (
              <>
                {" "}
                ({info.messageCount} message{info.messageCount === 1 ? "" : "s"}, {formatBytes(info.usedBytes)})
              </>
            ) : null}
            . This <b>cannot be undone</b> — there is no trash or backup.
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-on-surface">
            Type <code className="rounded border border-tertiary/30 bg-surface-container-lowest px-1.5 py-0.5 font-mono text-tertiary">{CONFIRM_WORD}</code> to confirm:
            <input
              aria-label={`Type ${CONFIRM_WORD} to confirm deleting ${email}`}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              disabled={deleting}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={cn(smallInput, "w-32")}
            />
          </div>
          <div className="mt-2.5 flex gap-2">
            <Button variant="danger" size="sm" onClick={() => void confirmDelete()} disabled={!armed || deleting}>
              {deleting ? "Deleting…" : "Delete mailbox"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirming(false);
                setConfirmText("");
                setDelErr(null);
              }}
              disabled={deleting}
            >
              Cancel
            </Button>
          </div>
          {delErr && <div className="mt-1.5 text-xs text-tertiary">{delErr}</div>}
        </div>
      )}

      {err && <div className="mt-1 text-xs text-tertiary">{err}</div>}
    </li>
  );
}
