import { useState } from "react";
import { ShieldCheck, ChevronDown, ChevronRight } from "lucide-react";

// A reassuring (not scary) panel that makes the admin aware of their
// responsibilities and shows how MailPoppy helps them meet them. The admin runs
// everything in their own AWS account, so they're the data controller — we frame
// that as empowering and point them in the right direction. Collapsible; the
// open/closed choice is remembered.

const KEY = "mailpoppy.privacyNoticeOpen";

function initialOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}

export function AdminPrivacyNotice() {
  const [open, setOpen] = useState(initialOpen);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  return (
    <section aria-label="Privacy and responsibilities" className="rounded-xl border border-primary/20 bg-primary/5 p-4">
      <button
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left font-semibold text-primary"
      >
        {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
        <ShieldCheck className="size-4 shrink-0" />
        Running this the right way — what MailPoppy handles for you
      </button>

      {open && (
        <div className="mt-3 text-sm leading-relaxed text-on-surface-variant">
          <p className="mb-2.5">
            MailPoppy runs entirely inside <b className="text-on-surface">your own AWS account</b>, so you stay in full
            control of your users' email. That control also makes you its <b className="text-on-surface">data controller</b> —
            and MailPoppy is built to help you handle that responsibly:
          </p>
          <ul className="mb-2.5 list-disc space-y-1.5 pl-5">
            <li>
              <b className="text-on-surface">Your AWS keys never leave your computer.</b> MailPoppy reads your AWS
              credentials the same way the AWS CLI does — from your machine's own configuration (your{" "}
              <code className="font-mono text-on-surface">~/.aws</code> profile, SSO, or environment) — and uses them{" "}
              <b className="text-on-surface">locally</b> to act on your account. It does <b className="text-on-surface">not</b>{" "}
              copy, upload, or store them anywhere — not on MailPoppy's servers, not in any cloud. The helper that uses them
              runs only on your own computer, and every AWS action goes straight from your machine to your account.
            </li>
            <li>
              <b className="text-on-surface">You choose where data lives.</b> Pick the AWS region below to match any
              data-residency rules that apply to your users (for example, an EU region for EU personal data).
            </li>
            <li>
              <b className="text-on-surface">You decide how long mail is kept.</b> Some rules set a minimum retention,
              others a maximum — MailPoppy lets you set a policy that fits (by default, mail is kept until you delete it).
            </li>
            <li>
              <b className="text-on-surface">Nothing is hidden.</b> The <b className="text-on-surface">AWS Resources</b> tab
              shows exactly what MailPoppy created in your account. Everything runs in your own account — and if you want a
              full access log, you can switch on AWS CloudTrail there yourself.
            </li>
          </ul>
          <p className="text-xs text-on-surface-variant/70">
            This is guidance to help you set things up correctly — not legal advice. When in doubt, check the rules that
            apply to your users.
          </p>
        </div>
      )}
    </section>
  );
}
