import { Inbox, ShieldCheck, ChevronDown } from "lucide-react";
import { Card } from "../ui";

// Plain-language reassurance + a non-technical checklist for the #1 question a
// new, non-technical admin asks: "why is my mail going to spam — is MailPoppy
// broken?" It isn't: a brand-new sending domain lands in spam on ANY provider
// until it earns reputation. This panel says so plainly, credits the auth setup
// MailPoppy already did (DKIM/SPF/DMARC/MAIL FROM), and tells them what THEY can
// do to improve placement. Lives at the top of Sending health (where a worried
// admin goes) and is static — no data, so it shows even while metrics load.

interface Step {
  title: string;
  detail: string;
}

const STEPS: Step[] = [
  {
    title: "Give it a little time",
    detail:
      "Reputation builds over the first few days to a couple of weeks of normal sending. Don't send a big burst on day one — a steady trickle of real messages warms the domain up.",
  },
  {
    title: "Ask your first recipients to rescue it",
    detail:
      'If an early email lands in spam, have them mark it "Not spam" / "Not junk", reply to it, or add your address to their contacts. A handful of these teaches Gmail and Outlook to trust you — fast.',
  },
  {
    title: "Tell people to check spam for the first few weeks",
    detail:
      'A short note on your sign-up or password-reset screen — "can\'t find it? check your spam folder" — avoids confused users while the domain is still warming up.',
  },
  {
    title: "Only email people who expect it",
    detail:
      "Sending to addresses that bounce, or that mark you as spam, is what actually damages your score. The numbers on this page are your early warning — keep bounces and spam-marks low.",
  },
  {
    title: "Make messages look like real mail",
    detail:
      'A clear subject, normal text (not one giant image), and links to your own website. Avoid ALL-CAPS subjects and "FREE!!!".',
  },
  {
    title: "Optional, for the keen",
    detail:
      "Sign up (free) for Google Postmaster Tools and Microsoft SNDS to watch your domain's reputation at Gmail and Outlook directly.",
  },
];

export function DeliverabilityGuide() {
  return (
    <Card className="border-primary/15 bg-primary-container/5">
      <div className="flex items-start gap-3">
        <Inbox className="mt-0.5 size-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-on-surface">
            New domains often land in spam at first — and that's normal
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-on-surface-variant">
            When a domain is brand new, inbox providers like Gmail and Outlook don't trust it yet, so they often file its
            first messages as spam. This happens to <em>every</em> new sending domain, on every provider — it isn't
            something MailPoppy is doing wrong, and switching email tools wouldn't avoid it. Trust is something a domain
            earns over a little time.
          </p>
          <p className="mt-2 flex items-start gap-1.5 text-sm leading-relaxed text-on-surface-variant">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-secondary" />
            <span>
              The technical groundwork is already done for you: MailPoppy signs your mail (DKIM), authorises it (SPF),
              protects your domain from being spoofed (DMARC) and aligns the sender address (custom MAIL FROM). That's
              the hard part — handled for every domain you set up.
            </span>
          </p>

          <details className="group mt-3 border-t border-outline-variant/10 pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-primary [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              How to land in the inbox — a short checklist
            </summary>
            <ol className="mt-3 flex list-none flex-col gap-3 p-0">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-on-surface">{s.title}</div>
                    <div className="mt-0.5 text-sm text-on-surface-variant">{s.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-on-surface-variant">
              Most domains start reaching the inbox within a few days to two weeks of steady, wanted mail. The figures
              below are your early-warning signs along the way.
            </p>
          </details>
        </div>
      </div>
    </Card>
  );
}
