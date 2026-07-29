import { useEffect, useState } from "react";
import { friendlyError } from "../lib/errors";
import {
  mailFromAlignment,
  defaultMailFromDomain,
  mailFromDnsRecords,
  type MailFromState,
  type DnsRecord,
} from "@mailpoppy/core";
import {
  getMailFromStatus as defaultGetMailFromStatus,
  setupMailFrom as defaultSetupMailFrom,
  type SetupMailFromResult,
} from "../lib/mailFrom";
import { Button } from "../ui";

// "Improve deliverability (SPF alignment)" card for the wizard's Sending-access
// section. SES's default Return-Path (…amazonses.com) leaves SPF unaligned to the
// sender's domain, which picky providers (Outlook/Hotmail) penalize. Configuring a
// custom MAIL FROM subdomain + its DNS makes SPF align too. load/setup are
// injectable so the card is unit-tested without a live sidecar.

type Tone = "success" | "info" | "danger" | "warn" | "neutral";
const bannerCls: Record<Tone, string> = {
  success: "border-secondary/30 bg-secondary/10 text-secondary",
  info: "border-primary/30 bg-primary/10 text-primary",
  danger: "border-tertiary/30 bg-tertiary-container/15 text-tertiary",
  warn: "border-warn/30 bg-warn/10 text-warn-bright",
  neutral: "border-outline-variant/20 bg-surface-container-lowest text-on-surface-variant",
};
function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2.5 text-sm ${bannerCls[tone]}`}>{children}</div>;
}

function RecordsTable({ records }: { records: DnsRecord[] }) {
  return (
    <table className="mt-2 border-collapse text-xs">
      <thead>
        <tr className="text-left text-on-surface-variant">
          <th className="pr-4 font-medium">Type</th>
          <th className="pr-4 font-medium">Name</th>
          <th className="font-medium">Value</th>
        </tr>
      </thead>
      <tbody className="text-on-surface">
        {records.map((r) => (
          <tr key={`${r.type}-${r.name}`}>
            <td className="pr-4 align-top">{r.type}</td>
            <td className="pr-4 align-top font-mono">{r.name}</td>
            <td className="align-top font-mono">{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface MailFromSetupProps {
  domain: string;
  region?: string;
  load?: (domain: string) => Promise<MailFromState>;
  setup?: (input: { domain: string; subdomain?: string }) => Promise<SetupMailFromResult>;
  /** Notified whenever the resolved MAIL FROM state changes (initial load + after
   *  applying setup), so a host view (e.g. DomainView) can keep its own status —
   *  badges, visibility of this panel — in sync without a full reload. */
  onStateChange?: (state: MailFromState) => void;
}

export function MailFromSetup({ domain, region = "eu-west-1", load, setup, onStateChange }: MailFromSetupProps) {
  const loadStatus = load ?? defaultGetMailFromStatus;
  const runSetup = setup ?? defaultSetupMailFrom;

  const [state, setState] = useState<MailFromState | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [recheckNote, setRecheckNote] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const s = await loadStatus(domain);
      setState(s);
      onStateChange?.(s);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  async function doSetup() {
    setBusy(true);
    setErr(null);
    try {
      const res = await runSetup({ domain });
      setState(res.state);
      onStateChange?.(res.state);
      setConfirming(false);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  // Manual "check again" for the pending banner. Unlike refresh() it does NOT toggle the
  // full-panel `loading` (that hides the whole banner in a jarring flash). It just busies the
  // button, and if SES still hasn't verified, leaves a readable note up for a few seconds so the
  // result doesn't vanish before it can be read.
  async function recheckStatus() {
    setRechecking(true);
    setErr(null);
    setRecheckNote(null);
    try {
      const s = await loadStatus(domain);
      setState(s);
      onStateChange?.(s);
      if (mailFromAlignment(s) === "pending") {
        setRecheckNote("Still verifying — DNS can take a few minutes to propagate. Try again shortly.");
        window.setTimeout(() => setRecheckNote(null), 3000);
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setRechecking(false);
    }
  }

  const alignment = mailFromAlignment(state);
  const mailFromDomain = state?.mailFromDomain ?? defaultMailFromDomain(domain);
  const previewRecords = mailFromDnsRecords(mailFromDomain, region);

  return (
    <div className="mt-4 border-t border-outline-variant/10 pt-4">
      <h3 className="flex items-center gap-2 text-base font-semibold text-on-surface">
        Improve deliverability — SPF alignment
        <span className="rounded-full border border-secondary/20 bg-secondary/10 px-2 py-0.5 text-xs font-semibold text-secondary">Recommended</span>
      </h3>
      <p className="mb-2.5 mt-1 text-sm text-on-surface-variant">
        <b className="text-on-surface">Recommended.</b> A custom <b>MAIL&nbsp;FROM</b> subdomain makes SPF align to{" "}
        <code className="font-mono text-on-surface">{domain}</code> (not just Amazon's domain), which improves inbox
        placement at strict providers like Outlook/Hotmail. It's safe and additive — your existing setup and mailboxes are
        unaffected.
      </p>

      {loading && <p className="text-sm text-on-surface-variant">Checking MAIL FROM status…</p>}

      {!loading && (
        <>
          {alignment === "aligned" && (
            <Banner tone="success">
              ✅ <b>Custom MAIL FROM active</b> — <code className="font-mono">{mailFromDomain}</code> is verified. SPF now
              aligns with your domain.
            </Banner>
          )}

          {alignment === "pending" && (
            <Banner tone="info">
              ⏳ <b>DNS written — SES is verifying</b> <code className="font-mono">{mailFromDomain}</code>. This can take a
              few minutes (DNS propagation). It keeps sending via the default Return-Path until verified, so nothing breaks.
              <div className="mt-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void recheckStatus()}
                  disabled={rechecking || busy}
                >
                  {rechecking ? "Checking…" : "Check verification status"}
                </Button>
                {recheckNote && <p className="mt-2 text-xs text-on-surface-variant">{recheckNote}</p>}
              </div>
            </Banner>
          )}

          {alignment === "failed" && (
            <Banner tone="danger">
              ⚠️ <b>MAIL FROM verification failed</b> for <code className="font-mono">{mailFromDomain}</code> — the MX/TXT
              records may be missing. You can re-apply them below.
            </Banner>
          )}

          {alignment === "not-configured" && (
            <Banner tone="warn">
              Not configured yet. Mail currently passes DMARC on DKIM alone (SPF is not aligned to your domain).{" "}
              <b>Enabling this is recommended</b> for better inbox placement.
            </Banner>
          )}

          {/* Offer setup when not configured or failed. */}
          {(alignment === "not-configured" || alignment === "failed") && (
            <div className="mt-2.5">
              <p className="mb-1 text-sm text-on-surface-variant">
                MailPoppy will point SES at <code className="font-mono text-on-surface">{mailFromDomain}</code> and add these
                DNS records:
              </p>
              <RecordsTable records={previewRecords} />

              {!confirming ? (
                <Button className="mt-2.5" onClick={() => setConfirming(true)} disabled={busy}>
                  Set up custom MAIL FROM (recommended)
                </Button>
              ) : (
                <div className="mt-2.5">
                  <Banner tone="neutral">
                    This adds the DNS records above to <b className="text-on-surface">{domain}</b> and updates SES. Continue?
                    <div className="mt-2 flex items-center gap-2">
                      <Button size="sm" onClick={() => void doSetup()} disabled={busy}>
                        {busy ? "Applying…" : "Apply DNS changes"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                        Cancel
                      </Button>
                    </div>
                  </Banner>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
    </div>
  );
}
