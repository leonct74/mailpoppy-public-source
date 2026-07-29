import { useEffect, useState } from "react";
import { KeyRound, Copy, Check, ShieldAlert, Eye, EyeOff } from "lucide-react";
import type { Authenticator } from "../lib/auth";
import { Card, Button, Spinner } from "../ui";
import { friendlyError } from "../lib/errors";

// Mailbox sign-in (Cognito). On success the parent gets a getToken() it hands to
// the live MailClient. Admin-created users are prompted to set a password first.

/** What `onEstablishKeys` reports back so the view can show the recovery key once
 *  (first keygen) or warn that a password reset re-keyed the mailbox. Structurally
 *  matches EstablishOutcome in ../lib/mailboxKeys, kept local so this view (and its
 *  test) need not pull in libsodium. */
export interface EstablishKeysOutcome {
  created: boolean;
  rekeyed: boolean;
  recoveryKey?: string;
}

const fieldCls =
  "w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";
const labelCls = "mb-1 block text-sm text-on-surface-variant";

/** Password field with a show/hide toggle (same affordance as the mobile app). */
function PasswordInput({
  ariaLabel,
  value,
  onChange,
  autoComplete,
}: {
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="relative">
      <input
        aria-label={ariaLabel}
        className={`${fieldCls} pr-9`}
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
      />
      <button
        type="button"
        aria-label={revealed ? "Hide password" : "Show password"}
        onClick={() => setRevealed((v) => !v)}
        tabIndex={-1}
        className="absolute inset-y-0 right-2.5 flex items-center text-on-surface-variant hover:text-on-surface"
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

export function LoginView({
  auth,
  onSignedIn,
  onReconfigure,
  prefillEmail,
  onEstablishKeys,
}: {
  auth: Authenticator;
  onSignedIn: () => void;
  onReconfigure?: () => void;
  prefillEmail?: string;
  /** Establish the mailbox encryption keypair for the just-authenticated session,
   *  using the password the user just typed (and the mailbox it belongs to, for the
   *  per-mailbox key cache). Optional: when omitted (e.g. tests, demo, or a
   *  deployment without the keys endpoint) sign-in proceeds unchanged. */
  onEstablishKeys?: (password: string, email: string) => Promise<EstablishKeysOutcome>;
}) {
  const [email, setEmail] = useState(prefillEmail ?? "");
  const [password, setPassword] = useState("");
  // When the user deep-links here from a specific mailbox (e.g. "Open inbox" in
  // the domain workspace), pre-fill the email so they only type a password.
  useEffect(() => {
    if (prefillEmail) setEmail(prefillEmail);
  }, [prefillEmail]);
  const [newPassword, setNewPassword] = useState("");
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Set once the mailbox keypair is freshly created: show the recovery key once
  // before entering the inbox. `rekeyed` means it followed an admin password reset.
  const [recovery, setRecovery] = useState<{ key: string; rekeyed: boolean } | null>(null);

  // Run key establishment (non-fatal) then either show the recovery key or finish.
  async function establishThenFinish(pw: string) {
    if (!onEstablishKeys) {
      onSignedIn();
      return;
    }
    try {
      const r = await onEstablishKeys(pw, email.trim().toLowerCase());
      if (r.created && r.recoveryKey) {
        setRecovery({ key: r.recoveryKey, rekeyed: r.rekeyed });
        return; // RecoveryKeyPanel takes over until acknowledged
      }
    } catch {
      // Encryption isn't enforced during rollout — never block sign-in on it.
    }
    onSignedIn();
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const pw = needsNewPassword ? newPassword : password;
      const res = needsNewPassword ? await auth.completeNewPassword(newPassword) : await auth.signIn(email.trim(), password);
      if (res.status === "new-password-required") {
        setNeedsNewPassword(true);
      } else {
        await establishThenFinish(pw);
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (recovery) {
    return <RecoveryKeyPanel recoveryKey={recovery.key} rekeyed={recovery.rekeyed} onContinue={onSignedIn} />;
  }

  return (
    <Card className="max-w-md">
      <h3 className="text-lg font-semibold text-on-surface">Sign in to your mailbox</h3>

      <div
        className="mt-4 flex flex-col gap-3"
        onKeyDown={(e) => {
          // No surrounding <form>, so give the fields the Enter-to-sign-in every
          // login screen is expected to have.
          if (e.key === "Enter" && !busy) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {!needsNewPassword ? (
          <>
            <div>
              <label className={labelCls}>Email</label>
              <input aria-label="Email" className={fieldCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourdomain.com" autoComplete="username" />
            </div>
            <div>
              <label className={labelCls}>Password</label>
              <PasswordInput ariaLabel="Password" value={password} onChange={setPassword} autoComplete="current-password" />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-on-surface-variant">Set a new password to finish activating this mailbox.</p>
            <div>
              <label className={labelCls}>New password</label>
              <PasswordInput ariaLabel="New password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" />
            </div>
          </>
        )}
      </div>

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => void submit()} disabled={busy}>
          {busy && <Spinner className="border-white/40 border-t-white" />}
          {busy ? "…" : needsNewPassword ? "Set password & sign in" : "Sign in"}
        </Button>
        {onReconfigure && (
          <button onClick={onReconfigure} className="text-sm text-primary underline-offset-2 hover:underline">
            Change deployment
          </button>
        )}
      </div>
    </Card>
  );
}

/**
 * Copy text to the clipboard, robust to contexts where the async Clipboard API is
 * blocked — e.g. inside a host iframe that doesn't delegate `clipboard-write`, or a
 * non-secure origin. Falls back to the legacy execCommand path, which only needs a
 * user gesture (the button click) and no Permissions-Policy grant.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Shown once, right after a mailbox keypair is created (first login, or a re-key
 * after an admin password reset). The recovery key is the user's ONLY way back
 * into their encrypted mail if they forget their password — no one, including the
 * admin, can recover it for them. So we gate "Continue" on an explicit "I've saved
 * it" acknowledgement.
 */
function RecoveryKeyPanel({ recoveryKey, rekeyed, onContinue }: { recoveryKey: string; rekeyed: boolean; onContinue: () => void }) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function copy() {
    if (await copyText(recoveryKey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
    /* if both paths fail, the key stays visible for manual selection */
  }

  return (
    <Card className="max-w-md">
      <div className="flex items-center gap-2">
        <KeyRound className="size-5 text-primary" />
        <h3 className="text-lg font-semibold text-on-surface">Save your recovery key</h3>
      </div>

      {rekeyed && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-tertiary/30 bg-tertiary/10 p-3 text-sm text-on-surface-variant">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-tertiary" />
          <span>Your password was reset, so a new encryption key was created. Mail received before the reset can no longer be opened — this is by design.</span>
        </div>
      )}

      <p className="mt-3 text-sm text-on-surface-variant">
        Your mailbox is encrypted with your password — not even the admin can read it. If you ever forget your
        password, this recovery key is the <strong>only</strong> way to get your mail back. Store it somewhere safe
        (a password manager is ideal). It is shown only once.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-3">
        <code aria-label="Recovery key" className="min-w-0 flex-1 break-all font-mono text-xs text-on-surface">
          {recoveryKey}
        </code>
        <button
          onClick={() => void copy()}
          className="flex shrink-0 items-center gap-1 rounded-md border border-outline-variant/30 px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container-high"
        >
          {copied ? <Check className="size-3.5 text-secondary" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <label className="mt-4 flex items-start gap-2 text-sm text-on-surface-variant">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I’ve saved my recovery key somewhere safe.</span>
      </label>

      <div className="mt-4">
        <Button onClick={onContinue} disabled={!acknowledged}>
          Continue to mailbox
        </Button>
      </div>
    </Card>
  );
}
