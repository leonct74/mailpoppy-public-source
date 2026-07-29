import { useEffect, useState } from "react";
import { HeartPulse, RefreshCw, PauseCircle, CheckCircle2, AlertTriangle, Ban, ShieldCheck } from "lucide-react";
import {
  domainHealth,
  dmarcHealth,
  type DeliverabilityOverview,
  type DomainDeliverability,
  type DomainDmarc,
  type HealthLevel,
} from "@mailpoppy/core";
import { getDeliverabilityOverview as defaultLoad } from "../lib/deliverability";
import { resolveStackName } from "../lib/deploymentConfig";
import { DeliverabilityGuide } from "./DeliverabilityGuide";
import { Card, Button, Spinner, cn } from "../ui";
import { friendlyError } from "../lib/errors";

// "Sending health" — the dedicated, per-domain view (DESIGN §13/§18 Phase 5).
// A non-technical admin can scroll one page and see, for every domain, whether
// the mail it sends is getting through. Two account-wide facts (sending paused?
// + daily quota) live in a header, because AWS enforces those per account — one
// bad domain can pause them all, which is exactly why the per-domain breakdown
// matters: spot the bad domain and remove its mailbox/domain before AWS acts.

type Tone = "good" | "watch" | "action" | "neutral";
const toneText: Record<Tone, string> = {
  good: "text-secondary",
  watch: "text-warn-bright",
  action: "text-tertiary",
  neutral: "text-on-surface-variant",
};
const toneDot: Record<Tone, string> = {
  good: "bg-secondary",
  watch: "bg-warn",
  action: "bg-tertiary",
  neutral: "bg-outline-variant",
};
const healthLabel: Record<HealthLevel, string> = {
  good: "Looking good",
  watch: "Worth watching",
  action: "Needs attention",
};

function pct(r: number): string {
  if (r <= 0) return "0%";
  const p = r * 100;
  return `${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function HealthChip({ level }: { level: HealthLevel }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", toneText[level])}>
      <span className={cn("size-2 rounded-full", toneDot[level])} />
      {healthLabel[level]}
    </span>
  );
}

/** A labelled stat with optional plain-language sub-line. */
function Stat({ label, value, sub, tone = "neutral" }: { label: string; value: string; sub?: string; tone?: Tone }) {
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className={cn("mt-0.5 text-xl font-semibold tracking-tight", tone === "neutral" ? "text-on-surface" : toneText[tone])}>
        {value}
      </div>
      {sub && <div className="text-xs text-on-surface-variant">{sub}</div>}
    </div>
  );
}

/**
 * Per-domain DMARC authentication, from the aggregate reports inbox providers
 * email back. Advisory (forwarders cause benign fails), so it's shown as its own
 * sub-row and never changes the card's main health chip.
 */
function DmarcRow({ dmarc }: { dmarc: DomainDmarc }) {
  const level = dmarcHealth(dmarc);
  const tone: Tone = level === "good" ? "good" : level === "watch" ? "watch" : "action";
  const passRate = Math.max(0, 1 - dmarc.failRate);
  return (
    <div className="mt-4 border-t border-outline-variant/10 pt-3">
      <div className="flex items-center justify-between gap-3">
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", toneText[tone])}>
          <ShieldCheck className="size-3.5" />
          Authentication (DMARC)
        </span>
        <span className={cn("text-xs font-medium", toneText[tone])}>{pct(passRate)} passed</span>
      </div>
      {level !== "good" && (
        <p className="mt-1 text-xs text-on-surface-variant">
          {pct(dmarc.failRate)} of the mail inbox providers saw claiming to come from this domain failed authentication.
          That's often a harmless forwarder or mailing list — but if you send a lot from here, it's worth checking that
          nobody is spoofing your domain.
        </p>
      )}
      <p className="mt-1 text-[11px] text-on-surface-variant">
        From {dmarc.reports.toLocaleString()} report{dmarc.reports === 1 ? "" : "s"} covering{" "}
        {dmarc.volume.toLocaleString()} message{dmarc.volume === 1 ? "" : "s"} inbox providers checked over the last{" "}
        {dmarc.windowDays} days.
      </p>
    </div>
  );
}

function DomainCard({ d }: { d: DomainDeliverability }) {
  const health = domainHealth(d);
  const sent = d.sends > 0;
  return (
    <div className="rounded-xl border border-outline-variant/10 bg-surface-container-highest/40 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-sm font-semibold text-on-surface">{d.domain}</div>
        {sent ? <HealthChip level={health} /> : <span className="text-xs text-on-surface-variant">No recent mail</span>}
      </div>

      {sent ? (
        <div className="mt-4 grid grid-cols-3 gap-4">
          <Stat label="Sent" value={d.sends.toLocaleString()} sub={`last ${d.windowDays} days`} />
          <Stat
            label="Bounced"
            value={`${d.bounces}`}
            sub={pct(d.bounceRate)}
            tone={d.bounces > 0 ? (health === "action" ? "action" : "watch") : "neutral"}
          />
          <Stat
            label="Marked spam"
            value={`${d.complaints}`}
            sub={pct(d.complaintRate)}
            tone={d.complaints > 0 ? "action" : "neutral"}
          />
        </div>
      ) : (
        <p className="mt-3 text-sm text-on-surface-variant">
          This domain hasn't sent any email in the last {d.windowDays} days, so there's nothing to measure yet.
        </p>
      )}

      {d.suppressedCount > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-on-surface-variant">
          <Ban className="size-3.5" />
          We've stopped emailing {d.suppressedCount} address{d.suppressedCount === 1 ? "" : "es"} that kept bouncing or
          reported spam.
        </div>
      )}

      {d.dmarc && d.dmarc.volume > 0 && <DmarcRow dmarc={d.dmarc} />}
    </div>
  );
}

export interface SendingHealthViewProps {
  stackName?: string;
  load?: (stackName: string) => Promise<DeliverabilityOverview>;
}

export function SendingHealthView({ stackName = resolveStackName(), load = defaultLoad }: SendingHealthViewProps) {
  const [data, setData] = useState<DeliverabilityOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setData(await load(stackName));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackName]);

  const account = data?.account;
  const domains = data?.domains ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
            <HeartPulse className="size-5 text-primary" />
            Sending health
          </h2>
          <p className="mt-1 max-w-2xl text-on-surface-variant">
            Whether the email each of your domains sends is actually reaching people — or starting to land in spam. Catch a
            problem domain here and you can remove its mailbox or the domain before it drags the others down.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw className="size-4" />}
          Refresh
        </Button>
      </div>

      {/* Why-is-my-mail-in-spam explainer. Static + reassurance-first, so it's
          shown above the metrics and even while they're still loading. */}
      <DeliverabilityGuide />

      {loading && !data ? (
        <Card>
          <div className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Spinner /> Checking your sending health…
          </div>
        </Card>
      ) : err ? (
        <Card className="border-tertiary/30 bg-tertiary-container/10">
          <div className="text-tertiary">Couldn't check your sending health: {err}</div>
          <p className="mt-1.5 text-sm text-on-surface-variant">
            Make sure the app's helper is running and your AWS access is set up, then try Refresh.
          </p>
        </Card>
      ) : account ? (
        <>
          {/* Account-wide header — the two facts AWS enforces per account. */}
          {account.sendingPaused ? (
            <Card className="border-tertiary/30 bg-tertiary-container/15">
              <div className="flex items-start gap-3 text-tertiary">
                <PauseCircle className="size-5 shrink-0" />
                <div>
                  <div className="font-semibold">Your sending is paused</div>
                  <p className="mt-0.5 text-sm opacity-90">
                    Amazon has temporarily stopped this whole account from sending — usually because too much mail bounced
                    or was marked as spam. Every domain is affected until it's resolved. The breakdown below shows which
                    domain is the likely cause.
                  </p>
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <CheckCircle2 className="size-5 text-secondary" />
                  <div>
                    <div className="font-semibold text-on-surface">Your account is in good standing</div>
                    <p className="text-sm text-on-surface-variant">
                      Sending is active. These two limits are set by Amazon for your whole account, not per domain.
                    </p>
                  </div>
                </div>
                <div className="flex gap-8">
                  <Stat
                    label="Sent today"
                    value={
                      account.dailyLimit < 0
                        ? account.dailyUsed.toLocaleString()
                        : `${account.dailyUsed.toLocaleString()} / ${account.dailyLimit.toLocaleString()}`
                    }
                    sub={account.dailyLimit < 0 ? "no daily limit" : "of your daily limit"}
                  />
                </div>
              </div>
            </Card>
          )}

          {/* Per-domain list. */}
          {domains.length === 0 ? (
            <Card className="bg-surface-container/60">
              <strong className="text-on-surface">No domains with mailboxes yet.</strong>
              <p className="mt-1 text-sm text-on-surface-variant">
                Once you add a domain and a mailbox, its sending health will appear here.
              </p>
            </Card>
          ) : (
            <div className="flex flex-col gap-4">
              {domains.map((d) => (
                <DomainCard key={d.domain} d={d} />
              ))}
            </div>
          )}

          <p className="text-xs text-on-surface-variant">
            Per-domain figures are MailPoppy's own running count and cover roughly the last{" "}
            {domains[0]?.windowDays ?? 14} days — they started counting when this feature was switched on, so a brand-new
            install will fill in over time. <AlertTriangle className="inline size-3 -translate-y-px" /> A domain showing{" "}
            <span className={toneText.action}>Needs attention</span> is the one to act on first.
          </p>
          <p className="text-xs text-on-surface-variant">
            <ShieldCheck className="inline size-3 -translate-y-px" /> <b className="text-on-surface">DMARC reports</b> appear
            on a domain once inbox providers start emailing back their daily summaries about it — MailPoppy already asks for
            these automatically, and they typically begin arriving within a day or two of a domain sending real mail. They
            tell you how much mail claiming to be from each domain actually passed authentication.
          </p>
        </>
      ) : null}
    </div>
  );
}
