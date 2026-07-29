// A plain-language summary of how MailPoppy protects a domain's email — the
// kind of thing an admin evaluating MailPoppy against WorkMail / a hosted
// provider wants to see up front. Everything listed is implemented in the
// deployed stack (see infra/lib/mail-stack.ts) except the clearly-marked
// optional add-on.

interface Feature {
  icon: string;
  title: string;
  detail: string;
  status: "on" | "optional";
}

const FEATURES: Feature[] = [
  {
    icon: "🏠",
    title: "Your data never leaves your AWS account",
    detail:
      "MailPoppy deploys the entire mail backend into your own AWS account. Your messages and attachments live in your S3 bucket and DynamoDB — no third party (including us) can read them.",
    status: "on",
  },
  {
    icon: "🔒",
    title: "Encrypted at rest",
    detail:
      "Mail in S3 is server-side encrypted (AES-256, SSE-S3); DynamoDB is encrypted at rest. The mail bucket blocks all public access.",
    status: "on",
  },
  {
    icon: "🔐",
    title: "Encrypted in transit",
    detail:
      "The S3 bucket enforces TLS (HTTPS-only); the mail API is HTTPS-only. Nothing is served over plaintext.",
    status: "on",
  },
  {
    icon: "🛡",
    title: "Virus & spam scanning on every inbound message",
    detail:
      "AWS SES scans each incoming email (attachments included). A message that fails the virus check is quarantined to Junk and never reaches your inbox; spam is routed to Junk. Each message shows its scan result.",
    status: "on",
  },
  {
    icon: "✅",
    title: "Sender authentication (SPF · DKIM · DMARC)",
    detail:
      "Inbound mail is checked against SPF, DKIM and DMARC, and the verdicts are shown per message. Outbound mail is DKIM-signed for your domain so it lands in inboxes, not spam.",
    status: "on",
  },
  {
    icon: "👤",
    title: "Per-mailbox isolation — no AWS keys on the mail path",
    detail:
      "Reading or sending mail requires a Cognito sign-in (JWT). The API derives which mailbox you may touch purely from the verified token, so one mailbox can never access another's mail. AWS credentials are used only by the admin app for provisioning, never for mail access.",
    status: "on",
  },
  {
    icon: "🧰",
    title: "Least-privilege & no public storage",
    detail:
      "Each function gets only the permissions it needs. Attachments are downloaded through short-lived (5-minute) signed links — the bucket itself is never public.",
    status: "on",
  },
  {
    icon: "🔬",
    title: "Deep malware scanning of stored files",
    detail:
      "Optional add-on (recommended): GuardDuty Malware Protection scans every stored attachment with a dedicated, signature-updated engine and blocks downloads of anything it flags — defense-in-depth on top of SES's scan. Enable it in Setup (small AWS usage cost; a personal mailbox is typically covered by the AWS free tier).",
    status: "optional",
  },
];

const badgeCls = (s: Feature["status"]) =>
  s === "on"
    ? "border-secondary/20 bg-secondary/10 text-secondary"
    : "border-warn/30 bg-warn/10 text-warn";

export function SecurityInfo({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Email security"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-base/80 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-outline-variant/20 bg-surface-container p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-on-surface">🔒 How your email is protected</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface">
            ✕
          </button>
        </div>
        <p className="mt-1.5 text-sm text-on-surface-variant">
          MailPoppy hosts your domain's email entirely inside your own AWS account. These protections are in place:
        </p>
        <ul className="mt-3 list-none p-0">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3 border-t border-outline-variant/10 py-2.5">
              <span className="text-xl leading-6" aria-hidden>
                {f.icon}
              </span>
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-sm text-on-surface">{f.title}</strong>
                  <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${badgeCls(f.status)}`}>
                    {f.status === "on" ? "Active" : "Recommended"}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-on-surface-variant">{f.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
