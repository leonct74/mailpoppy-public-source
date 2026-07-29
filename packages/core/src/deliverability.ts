// Deliverability / "sending health" model (DESIGN §13, §18 Phase 5). A fresh
// SES account on a fresh domain starts with NO sending reputation, so mail can
// quietly land in spam — and if too much of it bounces or gets marked as spam,
// AWS will throttle or suspend the account's ability to send at all. These pure
// helpers turn the raw SES numbers into a few plain-English health levels the UI
// can show without exposing the admin to AWS jargon.
//
// Thresholds mirror AWS's own published review/pause points:
//   • Bounces:    AWS reviews around 5%, can pause around 10%.
//   • Complaints: AWS reviews around 0.1%, can pause around 0.5%.
// We warn one band earlier than AWS acts, so the admin has runway to react.

/** A traffic-light health level. Deliberately not AWS terminology. */
export type HealthLevel = "good" | "watch" | "action";

/** Why an address was put on the do-not-send (suppression) list. */
export interface SuppressedAddress {
  address: string;
  /** "bounce" (mail kept failing) or "complaint" (marked as spam). */
  reason: string;
  /** Extra detail, e.g. the bounce type. */
  detail?: string;
  /** ISO timestamp the address was suppressed. */
  suppressedAt?: string;
  /** The sending domain whose mail triggered this (recorded going forward). */
  domain?: string;
}

/** Raw counts over the reporting window, summed from SES send statistics. */
export interface SendingTotals {
  deliveryAttempts: number;
  bounces: number;
  complaints: number;
  rejects: number;
}

export interface DeliverabilityStatus {
  totals: SendingTotals;
  /** Fraction (0..1) of attempts that bounced. */
  bounceRate: number;
  /** Fraction (0..1) of attempts marked as spam. */
  complaintRate: number;
  /** How many days of history the totals cover (SES keeps ~14). */
  windowDays: number;
  /** True if AWS has paused sending on this account (enforcement). */
  sendingPaused: boolean;
  /** Raw SES enforcement status, kept for an advanced/detail view (e.g. "HEALTHY"). */
  enforcementStatus?: string;
  /** Messages sent in the last 24h. */
  dailyUsed: number;
  /** Max messages per 24h. -1 means effectively unlimited (production, no quota). */
  dailyLimit: number;
  /** Addresses Mailpoppy has stopped sending to (from bounces/complaints). */
  suppressed: SuppressedAddress[];
}

/** Safe ratio — 0 when there's no send history yet (avoids NaN on a fresh account). */
export function rate(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Classify a bounce rate. Warn at 2%, flag at 5% (AWS's review point). */
export function bounceHealth(bounceRate: number): HealthLevel {
  if (bounceRate >= 0.05) return "action";
  if (bounceRate >= 0.02) return "watch";
  return "good";
}

/** Classify a complaint rate. Warn at 0.1% (AWS's review point), flag at 0.5%. */
export function complaintHealth(complaintRate: number): HealthLevel {
  if (complaintRate >= 0.005) return "action";
  if (complaintRate >= 0.001) return "watch";
  return "good";
}

/**
 * One overall health level for the headline banner. A paused account is always
 * "action"; otherwise it's the worst of the bounce and complaint levels.
 */
export function overallHealth(s: DeliverabilityStatus | null | undefined): HealthLevel {
  if (!s) return "good";
  if (s.sendingPaused) return "action";
  const levels: HealthLevel[] = [bounceHealth(s.bounceRate), complaintHealth(s.complaintRate)];
  if (levels.includes("action")) return "action";
  if (levels.includes("watch")) return "watch";
  return "good";
}

/** True when no mail has been sent yet — the UI shows a friendly "nothing to report" state. */
export function hasSendHistory(s: DeliverabilityStatus | null | undefined): boolean {
  return !!s && s.totals.deliveryAttempts > 0;
}

// ---- Per-domain view --------------------------------------------------------
// SES only reports bounce/complaint at the account level, so per-domain numbers
// are Mailpoppy's own tally: outbound counts come from each domain's stored Sent
// copies, and bounces/complaints are attributed to the sending domain by the
// suppression Lambda. These are forward-looking (they start when that's deployed).

export interface DomainDeliverability {
  domain: string;
  /** Messages this domain sent in the window (from stored Sent copies). */
  sends: number;
  bounces: number;
  complaints: number;
  bounceRate: number; // 0..1 of sends
  complaintRate: number; // 0..1 of sends
  /** Addresses we've stopped sending to that were triggered by this domain. */
  suppressedCount: number;
  windowDays: number;
  /**
   * DMARC aggregate-report rollup for this domain, when any reports have arrived.
   * An advisory authentication signal (forwarders can cause benign fails), so
   * it's shown alongside — not folded into — the main bounce/complaint health.
   * See `./dmarc` (DomainDmarc / dmarcHealth).
   */
  dmarc?: import("./dmarc").DomainDmarc;
}

/** Account-wide header (paused/quota + the authoritative all-domains SES totals) + per-domain rows. */
export interface DeliverabilityOverview {
  account: DeliverabilityStatus;
  domains: DomainDeliverability[];
}

/** Worst-of bounce/complaint health for one domain. Sends-but-no-problems = good. */
export function domainHealth(d: DomainDeliverability): HealthLevel {
  const levels: HealthLevel[] = [bounceHealth(d.bounceRate), complaintHealth(d.complaintRate)];
  if (levels.includes("action")) return "action";
  if (levels.includes("watch")) return "watch";
  return "good";
}
