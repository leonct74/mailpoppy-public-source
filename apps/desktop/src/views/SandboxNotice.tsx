import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { isSandboxed, type SesAccountStatus } from "@mailpoppy/core";
import { getSesAccount as defaultGetSesAccount } from "../lib/sesAccount";
import { ExtLink } from "../ui/ExtLink";
import { Card } from "../ui";

// Shown to a user who hasn't set anything up yet: the one AWS constraint that decides
// whether MailPoppy is usable for them, stated BEFORE they invest an hour in setup.
//
// Amazon puts every new SES account in a "sandbox" — it will only deliver to addresses
// verified with AWS. Lifting it is a manual review, opened as a support case. MailPoppy can
// submit that request, but AWS often replies with questions and only the account owner can
// answer them, in AWS's own Support Center. Finding that out at the end, after building a
// domain and mailboxes that can't email anyone, is the worst possible moment.
//
// Tailored rather than blanket: if the account can already be read and has production
// access, the warning is wrong for this user, so it says so instead. An unreadable account
// (no credentials yet — the usual state on this screen) shows the warning, because that is
// the safe assumption for a new AWS account.

export function SandboxNotice({ load }: { load?: () => Promise<SesAccountStatus> }) {
  const loadAccount = load ?? defaultGetSesAccount;
  // null = not known (no credentials yet, or the read failed) → assume sandbox.
  const [account, setAccount] = useState<SesAccountStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAccount().then(
      (a) => !cancelled && setAccount(a),
      () => {
        /* unreadable — keep the warning, which is the safe default */
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (account && !isSandboxed(account)) {
    return (
      <Card className="border-secondary/30 bg-secondary/5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-secondary" />
          <div className="text-sm leading-relaxed text-on-surface-variant">
            <b className="text-on-surface">Your AWS account can already email anyone.</b> Amazon has granted it production
            access, so there is nothing standing in your way — set up as many domains and mailboxes as you like.
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="border-warn/40 bg-warn/10">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn-bright" />
        <div className="text-sm leading-relaxed text-on-surface-variant">
          <div className="text-base font-semibold text-on-surface">Before you start: Amazon limits new accounts</div>
          <p className="mt-1.5">
            Amazon keeps every new AWS account in a <b className="text-on-surface">sandbox</b>. Mailboxes you create work
            normally, but they can only send to addresses you have verified with AWS — not to ordinary people. Until that
            is lifted, <b className="text-on-surface">MailPoppy can be set up but not really used</b>.
          </p>
          <p className="mt-2">
            Lifting it means asking Amazon, which opens a support ticket. MailPoppy submits that request for you once
            setup is done — but Amazon usually replies with questions about how you plan to use email, and{" "}
            <b className="text-on-surface">only you can answer those</b>, in Amazon&apos;s own{" "}
            <ExtLink href="https://console.aws.amazon.com/support/home#/cases" className="text-primary hover:underline">
              Support Center
            </ExtLink>
            . MailPoppy will show you what they ask for and give you answers you can copy. Approval usually takes a day or
            so once they have what they need.
          </p>
          <p className="mt-2">
            <b className="text-on-surface">Already had the sandbox limit removed on this AWS account?</b> Then none of
            this applies — go ahead and set up as many domains and mailboxes as you like.
          </p>
        </div>
      </div>
    </Card>
  );
}
