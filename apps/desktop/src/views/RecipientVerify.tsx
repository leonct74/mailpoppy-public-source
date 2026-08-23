import { useEffect, useRef, useState } from "react";
import { MailCheck } from "lucide-react";
import { friendlyError } from "../lib/errors";
import { isSandboxed, type SesAccountStatus, type RecipientVerification } from "@mailpoppy/core";
import {
  getSesAccount as defaultGetSesAccount,
  getRecipientVerification as defaultGetRecipientVerification,
  verifyRecipient as defaultVerifyRecipient,
} from "../lib/sesAccount";
import { validateTestRecipient } from "../lib/deliverability";
import { Button, Spinner } from "../ui";

// "Verify your address with AWS" panel for the wizard's test step. A brand-new
// AWS account is in the SES SANDBOX: it can only send to addresses verified with
// AWS, so the deliverability test to the admin's personal inbox is rejected
// unless that address is verified first. This panel detects the sandbox, sends
// the AWS verification email in-app (CreateEmailIdentity → AWS mails a
// click-link), and auto-polls until the address turns verified — so the setup
// never dead-ends on a raw "Email address is not verified" error.
//
// Fail-safe: if the account state can't be read, render nothing (don't block the
// test). The wizard also force-shows this panel when a test send actually fails
// with the unverified-recipient rejection, covering that blind spot.
// loadAccount/check/verify are injectable so the panel is unit-tested without a
// live sidecar.

type Tone = "success" | "info" | "warn" | "danger";
const toneCls: Record<Tone, string> = {
  success: "border-secondary/30 bg-secondary/10 text-secondary",
  info: "border-primary/30 bg-primary/10 text-primary",
  warn: "border-warn/30 bg-warn/10 text-warn-bright",
  danger: "border-tertiary/30 bg-tertiary-container/15 text-tertiary",
};
function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2.5 text-sm ${toneCls[tone]}`}>{children}</div>;
}

export interface RecipientVerifyProps {
  /** The recipient typed in the wizard's test step (may be empty or invalid). */
  recipient: string;
  /** The domain being set up (for recipient validation). */
  domain: string;
  /** Show even when the account read failed — a send just bounced off the sandbox. */
  forceSandbox?: boolean;
  /** Notify the wizard so it can enable/relabel the send button. */
  onVerified?: (verified: boolean) => void;
  loadAccount?: () => Promise<SesAccountStatus>;
  check?: (email: string) => Promise<RecipientVerification>;
  verify?: (email: string) => Promise<RecipientVerification>;
}

export function RecipientVerify({ recipient, domain, forceSandbox, onVerified, loadAccount, check, verify }: RecipientVerifyProps) {
  const load = loadAccount ?? defaultGetSesAccount;
  const checkFn = check ?? defaultGetRecipientVerification;
  const verifyFn = verify ?? defaultVerifyRecipient;

  // null = still loading / couldn't read (fail-safe: hidden unless forced).
  const [sandboxed, setSandboxed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<RecipientVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const email = recipient.trim().toLowerCase();
  const emailValid = !!email && validateTestRecipient(email, domain) === null;
  const show = forceSandbox || sandboxed === true;
  const state = status?.email === email ? status.state : null;

  useEffect(() => {
    let cancelled = false;
    load().then(
      (account) => {
        if (!cancelled) setSandboxed(isSandboxed(account));
      },
      () => {
        if (!cancelled) setSandboxed(null); // unknown — stay hidden unless forced
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check the typed address whenever the panel is visible, and keep polling
  // while AWS waits for the click (the user verifies in another window).
  useEffect(() => {
    if (!show || !emailValid) return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await checkFn(email);
        if (cancelled) return;
        setStatus(s);
        onVerified?.(s.state === "verified");
        if (s.state === "pending") pollRef.current = window.setTimeout(poll, 5000);
      } catch {
        // transient — leave the last known state
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, email, emailValid]);

  async function sendVerification() {
    setErr(null);
    setBusy(true);
    try {
      const s = await verifyFn(email);
      setStatus(s);
      onVerified?.(s.state === "verified");
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!show) return null;

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Banner tone="info">
        Your AWS account is new to sending email, so Amazon keeps it in a <b>“sandbox”</b> for now: it will only deliver to
        addresses that have been <b>verified with AWS</b>. Quick fix for this test — verify your own address below (AWS emails
        you a link to click). To send to anyone without verifying, request production access later under{" "}
        <b>Account → Sending access</b>.
      </Banner>

      {emailValid && state === "verified" && (
        <Banner tone="success">
          <span className="inline-flex items-center gap-1.5">
            <MailCheck className="size-4" /> <b>{email}</b> is verified with AWS — the test email will be delivered.
          </span>
        </Banner>
      )}

      {emailValid && state === "pending" && (
        <Banner tone="warn">
          <span className="inline-flex items-center gap-2">
            <Spinner className="shrink-0" />
            <span>
              AWS has emailed a verification link to <b>{email}</b> — open that inbox (check spam too) and click the link.
              This panel updates by itself once it&apos;s clicked.
            </span>
          </span>
          <div className="mt-2">
            <Button variant="ghost" size="sm" onClick={sendVerification} disabled={busy}>
              Re-send the verification email
            </Button>
          </div>
        </Banner>
      )}

      {emailValid && state === "failed" && (
        <Banner tone="danger">
          The verification link for <b>{email}</b> expired before it was clicked (AWS gives 24 hours). Send a fresh one and
          click it soon after it arrives.
          <div className="mt-2">
            <Button size="sm" onClick={sendVerification} disabled={busy}>
              Send a new verification email
            </Button>
          </div>
        </Banner>
      )}

      {/* state === null covers the first status check still being in flight (or
          failing): the button stays clickable — verifyRecipient is a safe no-op
          on an already-verified address, and a real failure surfaces below. */}
      {emailValid && (state === "not-started" || state === null) && (
        <div>
          <Button onClick={sendVerification} disabled={busy}>
            <MailCheck className="size-4" /> Verify {email} with AWS
          </Button>
        </div>
      )}

      {err && <p className="text-sm text-tertiary">{err}</p>}
    </div>
  );
}
