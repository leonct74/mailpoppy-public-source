// Custom MAIL FROM domain (DESIGN §13 — deliverability / SPF alignment).
//
// By default SES uses its own Return-Path (…amazonses.com), so a message passes
// DMARC only via DKIM alignment — SPF is authenticated for amazonses.com, NOT
// aligned to the sender's domain. Picky providers (notably Outlook/Hotmail) weigh
// SPF alignment. Pointing SES at a custom MAIL FROM subdomain (e.g. mail.<domain>)
// with its own MX + SPF records makes SPF align to the organizational domain too —
// both DMARC pillars pass. These pure helpers derive the subdomain, the required
// DNS records, and a UI-friendly alignment state.

/** SESv2 MailFromDomainStatus, plus our "not configured yet" sentinel. */
export type MailFromStatus = "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "NOT_STARTED";

export interface MailFromState {
  mailFromDomain?: string;
  status?: MailFromStatus;
  behaviorOnMxFailure?: string;
}

export type MailFromAlignment = "aligned" | "pending" | "failed" | "not-configured";

/** Collapse the raw SES MAIL FROM attributes into one UI state. */
export function mailFromAlignment(s: MailFromState | null | undefined): MailFromAlignment {
  if (!s || !s.mailFromDomain) return "not-configured";
  if (s.status === "SUCCESS") return "aligned";
  if (s.status === "FAILED") return "failed";
  return "pending"; // PENDING / TEMPORARY_FAILURE / NOT_STARTED while a domain is set
}

/** The conventional MAIL FROM subdomain for a domain. */
export function defaultMailFromDomain(domain: string): string {
  return `mail.${domain.trim().toLowerCase().replace(/\.$/, "")}`;
}

export interface DnsRecord {
  type: "MX" | "TXT";
  name: string;
  value: string;
}

/**
 * The DNS records SES requires on a custom MAIL FROM domain, for a given region:
 *  - an MX to SES's feedback endpoint (so bounces flow back), and
 *  - an SPF TXT authorizing amazonses.com.
 * The MX host is region-specific.
 */
export function mailFromDnsRecords(mailFromDomain: string, region: string): DnsRecord[] {
  const name = mailFromDomain.trim().toLowerCase().replace(/\.$/, "");
  return [
    { type: "MX", name, value: `10 feedback-smtp.${region}.amazonses.com` },
    { type: "TXT", name, value: `"v=spf1 include:amazonses.com ~all"` },
  ];
}
