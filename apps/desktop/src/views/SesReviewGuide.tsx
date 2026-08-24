import { useState } from "react";
import { Check, Copy, ChevronDown, ChevronRight } from "lucide-react";
import { copyText } from "../lib/clipboard";
import { ExtLink } from "../ui/ExtLink";
import { Button, cn } from "../ui";

// What to do while Amazon reviews a production-access request.
//
// Why this exists at all: MailPoppy submits the request and can read the verdict, but the
// review is an AWS SUPPORT CASE — a conversation on Amazon's own site. Amazon frequently
// replies with a question and then WAITS, forever, because nothing expires and nothing
// chases the user. MailPoppy cannot answer for them (the AWS Support API needs a paid
// support plan a new account doesn't have), so the ONLY thing that moves the request
// forward is the user going and replying.
//
// The audience makes this a product problem rather than a footnote: many MailPoppy admins
// have never used AWS and have never filed a support ticket anywhere. "We submitted your
// request" reads to them as "you're done" — so they wait indefinitely on a question they
// never saw. Hence: an explicit check-back instruction, plain-language notes on what Amazon
// wants to know, and ready-made example answers, because facing an empty reply box with no
// idea what's expected is where people give up.

const SUPPORT_CASES_URL = "https://console.aws.amazon.com/support/home#/cases";

/** Ready-made answers covering the realistic shapes of MailPoppy user. Each one implicitly
 *  answers all four things Amazon asks (purpose, volume, who the recipients are and why
 *  they expect it, and what happens to bounces/complaints) — a vague answer is the usual
 *  reason Amazon comes back with more questions. */
const EXAMPLES: { label: string; text: string }[] = [
  {
    label: "A business using it for staff email",
    text:
      "We host email on our own domain for our staff mailboxes. It is ordinary business correspondence: replies to customers who contacted us, and messages to our suppliers, our accountant and our own team — around 100 messages a day in total. We do not send bulk or marketing email and we have no mailing list. If an address bounces we stop using it, hard bounces go onto Amazon's suppression list so they are not retried, and anyone who asks us to stop hearing from us is removed.",
  },
  {
    label: "An online shop sending order email",
    text:
      "I need email for my own business domain, which is an ecommerce website. The mail is transactional — order confirmations, shipping notices, password resets and replies to customer enquiries — sent to customers who have bought from us or who hold an account with us. I expect up to 10,000 messages a day. We do not buy or import address lists. Hard bounces go onto Amazon's suppression list and are not retried, we remove addresses that keep failing, and anyone who reports our mail as spam or asks to stop receives nothing further.",
  },
  {
    label: "A freelancer or consultant",
    text:
      "I am self-employed and this is my work email on my own domain. It is day-to-day correspondence with clients I already work with, plus replies to people who write to me first — perhaps 50 messages a day, all typed by hand. There is no marketing and no mailing list. If an address bounces I stop using it, hard bounces go onto Amazon's suppression list, and if someone asks me not to write to them again, I do not.",
  },
];

function CopyableExample({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (await copyText(text)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }
  return (
    <div className="rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" /> Copy
            </>
          )}
        </Button>
      </div>
      <p className="text-sm leading-relaxed text-on-surface-variant">{text}</p>
    </div>
  );
}

export function SesReviewGuide({ className, region }: { className?: string; region?: string }) {
  const [open, setOpen] = useState(false);
  // A wrong-region console link is worse than a neutral one: it would show a different
  // account state. Without a known region, let AWS resolve the last region used.
  const sesUrl = region
    ? `https://${region}.console.aws.amazon.com/ses/home?region=${region}#/account`
    : "https://console.aws.amazon.com/ses/home#/account";

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <p>
        <b className="text-on-surface">Today:</b> your request is with Amazon. If they need nothing from you, they usually
        decide within 24 hours. Amazon emails the address on your AWS account; this panel shows the result next time you
        open it, or when you press <b className="text-on-surface">Check again</b> below.
      </p>
      <p>
        <b className="text-on-surface">Tomorrow, even if you have heard nothing:</b> go and look. Amazon often replies with
        a question instead of deciding, and that reply lands in a <i>support case</i> — a written conversation on Amazon&apos;s
        own website, not in your mailbox. The email announcing it is easy to miss. Nothing expires and nothing chases you, so
        an unanswered question leaves your request sitting there indefinitely.
      </p>
      <p>
        <ExtLink href={SUPPORT_CASES_URL} className="text-primary hover:underline">
          Open your AWS support cases →
        </ExtLink>{" · "}
        <ExtLink href={sesUrl} className="text-primary hover:underline">
          SES account dashboard →
        </ExtLink>{" "}
        <span className="text-on-surface-variant">
          — sign in with the same AWS account you set up here, open your case, and read the last message. Being asked
          something is normal; it does not mean you are being turned down.
        </span>
      </p>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="mt-1 flex items-center gap-1.5 self-start text-sm font-medium text-primary hover:underline"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        What Amazon will ask — and answers you can copy
      </button>

      {open && (
        <div className="mt-1 flex flex-col gap-3 border-l-2 border-outline-variant/20 pl-3">
          <p className="text-sm text-on-surface-variant">
            Amazon lets anyone send mail through its servers, so people abuse it constantly and a human reads each request.
            They are really asking one thing: <b className="text-on-surface">who are you emailing, and why is that alright?</b>{" "}
            Four details answer it — what the mail is for, roughly how many messages a day, who receives them and why those
            people expect to hear from you, and what happens to addresses that bounce or people who ask you to stop.
          </p>
          <p className="text-sm text-on-surface-variant">
            On that last one you can say that addresses which hard-bounce go onto Amazon&apos;s own suppression list and
            are not delivered to again — that is AWS&apos;s own mechanism, on by default, and reviewers know it. Say what
            <i>you</i> do as well: stop using an address that bounces, and remove anyone who asks you to. Write a few honest
            sentences about your real business — vague answers are what leads to more questions.
          </p>
          <div className="flex flex-col gap-2">
            {EXAMPLES.map((e) => (
              <CopyableExample key={e.label} {...e} />
            ))}
          </div>
          <p className="text-xs text-on-surface-variant/80">
            MailPoppy sent the request and will show you the verdict, but the conversation lives inside your AWS account,
            which only you can sign in to — Amazon opens support cases to software only on paid support plans. If Amazon
            asks something, you are the one who answers, and until someone does the review stops there.
          </p>
        </div>
      )}
    </div>
  );
}
