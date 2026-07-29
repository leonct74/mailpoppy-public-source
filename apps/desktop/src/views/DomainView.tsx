import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Globe,
  Inbox,
  Mail,
  Plus,
  RefreshCw,
  Server,
  ArrowLeftRight,
  Settings,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Trash2,
  FileSpreadsheet,
} from "lucide-react";
import { mailFromAlignment, type MailFromState } from "@mailpoppy/core";
import { resolveStackName, saveDeploymentConfig } from "../lib/deploymentConfig";
import {
  listMailboxes as defaultListMailboxes,
  createMailbox as defaultCreateMailbox,
  type Mailbox,
  type BackendInfo,
} from "../lib/mailbox";
import { getMailFromStatus as defaultGetMailFrom } from "../lib/mailFrom";
import { getDomainIdentityStatus as defaultGetDomainStatus, type DomainIdentityStatus } from "../lib/provision";
import { removeDomain as defaultRemoveDomain, type RemoveDomainResult } from "../lib/teardown";
import { friendlyError } from "../lib/errors";
import { withTimeout } from "../lib/withTimeout";
import { MailboxStorageRow } from "./MailboxStorageRow";
import { PolicyEditor } from "./PolicyEditor";
import { RetentionEditor } from "./RetentionEditor";
import { MailFromSetup } from "./MailFromSetup";
import { MobileAppAccess } from "./MobileAppAccess";
import { MailboxImport } from "./MailboxImport";
import { Card, Button, Spinner, cn } from "../ui";

// Domain workspace — the per-domain drill-in reached from a Home card. A
// MailPoppy admin runs several domains on ONE shared backend, so this view
// scopes everything genuinely per-domain: its SES/DKIM/MAIL FROM health, the
// mailboxes on this domain, adding a mailbox, opening its inbox, importing old
// mail, and this domain's mail rules + retention (each scoped to `policy#<domain>`
// / `retention#<domain>`). The truly account-wide concerns — SES sending access,
// the AWS resource inventory + teardown — live in the Account tab instead.

type Tone = "ok" | "warn" | "muted" | "bad";
const TONE: Record<Tone, string> = {
  ok: "border-secondary/20 bg-secondary/10 text-secondary",
  warn: "border-warn/30 bg-warn/10 text-warn",
  muted: "border-outline-variant/20 bg-surface-container-highest/40 text-on-surface-variant",
  bad: "border-tertiary/30 bg-tertiary-container/15 text-tertiary",
};
function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-[11px]", TONE[tone])}>
      {children}
    </span>
  );
}

const isNoBackend = (e: unknown) => {
  const m = String(e);
  return /\b404\b/.test(m) && /No deployed MailPoppy backend/i.test(m);
};

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

const inputCls =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-outline-variant transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
const noAutoCap = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

export function DomainView({
  domain,
  stackName = resolveStackName(),
  onBack,
  onRunSetup,
  onOpenInbox,
  onMigrateInto,
  onRemoved,
  listMailboxes = defaultListMailboxes,
  createMailbox = defaultCreateMailbox,
  getDomainStatus = defaultGetDomainStatus,
  getMailFrom = defaultGetMailFrom,
  removeDomain = defaultRemoveDomain,
}: {
  domain: string;
  stackName?: string;
  onBack?: () => void;
  onRunSetup?: () => void;
  onOpenInbox?: (email: string) => void;
  onMigrateInto?: (domain: string) => void;
  onRemoved?: (domain: string) => void;
  listMailboxes?: (stackName: string) => Promise<BackendInfo & { ok: true; mailboxes: Mailbox[] }>;
  createMailbox?: (input: { email: string; password: string; stackName?: string }) => Promise<
    BackendInfo & { ok: true; mailbox: Mailbox }
  >;
  getDomainStatus?: (domain: string) => Promise<DomainIdentityStatus>;
  getMailFrom?: (domain: string) => Promise<MailFromState>;
  removeDomain?: (input: { domain: string; stackName?: string }) => Promise<RemoveDomainResult>;
}) {
  type Phase = "loading" | "no-backend" | "ready" | "error";
  const [phase, setPhase] = useState<Phase>("loading");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [backend, setBackend] = useState<BackendInfo | null>(null);
  const [domStatus, setDomStatus] = useState<DomainIdentityStatus | "error" | null>(null);
  const [mailFrom, setMailFrom] = useState<MailFromState | "error" | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Add-mailbox form. The address is always on THIS domain, so we collect just
  // the local part and append "@domain".
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [mbBusy, setMbBusy] = useState(false);
  const [mbError, setMbError] = useState<string | null>(null);
  const [mbCreated, setMbCreated] = useState<string | null>(null);
  // Bulk import (many mailboxes from a spreadsheet) — toggled open under the
  // single-create form. Gated by the same "domain verified for sending" rule.
  const [showImport, setShowImport] = useState(false);

  // Danger zone — remove THIS domain (its mailboxes + mail + SES + DNS), leaving
  // the shared backend and every other domain intact. Type-to-confirm gates it.
  const [dangerOpen, setDangerOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [removing, setRemoving] = useState(false);
  const [removeResult, setRemoveResult] = useState<RemoveDomainResult | null>(null);
  const [removeErr, setRemoveErr] = useState<string | null>(null);

  async function reload() {
    const res = await withTimeout(listMailboxes(stackName), "mailboxes");
    setMailboxes(res.mailboxes);
    setBackend({ region: res.region, userPoolId: res.userPoolId, clientId: res.clientId, apiBaseUrl: res.apiBaseUrl });
  }

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setErrMsg(null);
    setDomStatus(null);
    setMailFrom(null);
    (async () => {
      try {
        await reload();
        if (cancelled) return;
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        if (isNoBackend(e)) setPhase("no-backend");
        else {
          setErrMsg(friendlyError(e));
          setPhase("error");
        }
        return;
      }
      // Health badges, best-effort and independent.
      getDomainStatus(domain)
        .then((s) => !cancelled && setDomStatus(s))
        .catch(() => !cancelled && setDomStatus("error"));
      getMailFrom(domain)
        .then((s) => !cancelled && setMailFrom(s))
        .catch(() => !cancelled && setMailFrom("error"));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, stackName, reloadKey]);

  const onDomain = mailboxes.filter((m) => domainOf(m.email) === domain.toLowerCase());

  async function createMb() {
    const local = localPart.trim().toLowerCase();
    if (!local || !password) return;
    const email = `${local}@${domain}`;
    setMbBusy(true);
    setMbError(null);
    setMbCreated(null);
    try {
      const res = await createMailbox({ email, password, stackName });
      setMbCreated(res.mailbox.email);
      setLocalPart("");
      setPassword("");
      // Persist the backend config so the Inbox tab can sign in immediately.
      if (res.apiBaseUrl && res.userPoolId && res.clientId) {
        saveDeploymentConfig({
          apiBaseUrl: res.apiBaseUrl,
          userPoolId: res.userPoolId,
          clientId: res.clientId,
          region: res.region,
          stackName,
        });
      }
      await reload();
    } catch (e) {
      setMbError(friendlyError(e));
    } finally {
      setMbBusy(false);
    }
  }

  const canRemove = confirmText.trim().toLowerCase() === domain.toLowerCase() && !removing;

  async function onRemove() {
    if (!canRemove) return;
    setRemoving(true);
    setRemoveErr(null);
    try {
      const res = await removeDomain({ domain, stackName });
      setRemoveResult(res);
      onRemoved?.(domain);
    } catch (e) {
      setRemoveErr(friendlyError(e));
    } finally {
      setRemoving(false);
    }
  }

  // ---- Header (always shown so the user can navigate back) ----
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back to overview"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-outline-variant/20 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <Globe className="size-5 shrink-0 text-primary" />
        <div className="min-w-0">
          <div className="font-mono text-xs uppercase tracking-wider text-primary">Domain</div>
          <h2 className="truncate text-2xl font-bold tracking-tight text-on-surface">{domain}</h2>
        </div>
      </div>
      <div className="flex gap-2">
        {onRunSetup && (
          <Button variant="secondary" onClick={onRunSetup}>
            <Settings className="size-4" /> Domain setup
          </Button>
        )}
        <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
          <RefreshCw className="size-4" /> Refresh
        </Button>
      </div>
    </div>
  );

  if (phase === "loading") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Spinner /> Loading {domain}…
        </div>
      </div>
    );
  }

  if (phase === "no-backend") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <div className="flex items-center gap-2 text-on-surface">
            <Server className="size-4 text-primary" />
            <span>No backend is deployed yet.</span>
          </div>
          <p className="mt-2 text-sm text-on-surface-variant">
            Deploy your backend and set up this domain from the <b className="text-on-surface">Setup</b> tab first — then
            its mailboxes and health will show up here.
          </p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card>
          <h3 className="text-lg font-semibold text-on-surface">Couldn't load {domain}</h3>
          <p className="mt-2 text-sm text-tertiary">{errMsg}</p>
          <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
            This usually means this domain was <b className="text-on-surface">only partly set up</b> — created, but its
            backend deploy or DNS step never finished. It can also happen if the backend is in a{" "}
            <b className="text-on-surface">different AWS region</b> than your linked account, or your AWS credentials need
            attention.
          </p>
          {onRunSetup && (
            <p className="mt-2 text-sm leading-relaxed text-on-surface-variant">
              The quickest fix is to <b className="text-on-surface">resume the setup</b> — it picks up from wherever it
              stopped and reuses anything already created, so you won't get duplicates.
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {onRunSetup && (
              <Button onClick={onRunSetup}>
                <Settings className="size-4" /> Resume {domain} setup
              </Button>
            )}
            <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              <RefreshCw className="size-4" /> Retry
            </Button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-on-surface-variant/80">
            Still stuck? If this domain can't be recovered, remove it from the{" "}
            <b className="text-on-surface">AgentsPoppy</b> console (tear it down there) and start fresh.
          </p>
        </Card>
      </div>
    );
  }

  // ---- Ready ----
  // Block adding mailboxes until the domain's SES + DNS are verified for sending —
  // a mailbox on a domain that can't yet send or receive is a dead end. Only block
  // when we KNOW it's unverified (status loaded, not an error) so a transient status
  // hiccup never falsely blocks a working domain.
  const domainUnverified = domStatus !== null && domStatus !== "error" && !domStatus.verifiedForSending;
  return (
    <div className="flex flex-col gap-6">
      {header}

      {/* Domain health badges. */}
      <Card>
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-primary" />
          <h3 className="font-semibold text-on-surface">Domain health</h3>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {domStatus === null ? (
            <Pill tone="muted">DKIM …</Pill>
          ) : domStatus === "error" ? (
            <Pill tone="muted">DKIM unknown</Pill>
          ) : domStatus.dkim === "SUCCESS" ? (
            <Pill tone="ok">DKIM verified</Pill>
          ) : (
            <Pill tone="warn">DKIM {domStatus.dkim.toLowerCase()}</Pill>
          )}

          {domStatus && domStatus !== "error" && (
            <Pill tone={domStatus.verifiedForSending ? "ok" : "warn"}>
              {domStatus.verifiedForSending ? "Can send" : "Not sending yet"}
            </Pill>
          )}

          {mailFrom === null ? (
            <Pill tone="muted">MAIL FROM …</Pill>
          ) : mailFrom === "error" ? (
            <Pill tone="muted">MAIL FROM unknown</Pill>
          ) : (mailFrom.status ?? "").toLowerCase() === "success" ? (
            <Pill tone="ok">MAIL FROM aligned</Pill>
          ) : mailFrom.mailFromDomain ? (
            <Pill tone="warn">MAIL FROM pending</Pill>
          ) : (
            <Pill tone="muted">MAIL FROM not set</Pill>
          )}
        </div>
        {domStatus && domStatus !== "error" && !domStatus.verifiedForSending && (
          <p className="mt-3 text-xs text-on-surface-variant/80">
            DNS for this domain isn't fully verified yet.{" "}
            {onRunSetup ? (
              <button onClick={onRunSetup} className="text-primary underline-offset-2 hover:underline">
                Finish or re-check its setup →
              </button>
            ) : (
              <>Finish or re-check it from <b className="text-on-surface">Domain setup</b>.</>
            )}
          </p>
        )}
      </Card>

      {/* When MAIL FROM (SPF alignment) isn't aligned yet, surface the full setup
          panel prominently here — not buried at the tail of the domain-setup wizard —
          so the admin actually completes this deliverability step. It hides itself
          once aligned (the Domain-health pill then reads "MAIL FROM aligned"). The
          same getMailFrom loader is shared so the panel and the badge agree, and
          onStateChange keeps the badge live after the admin applies the change. */}
      {mailFrom && mailFrom !== "error" && mailFromAlignment(mailFrom) !== "aligned" && (
        <Card className="border-warn/30 bg-warn/5">
          <MailFromSetup
            domain={domain}
            region={backend?.region}
            load={getMailFrom}
            onStateChange={(s) => setMailFrom(s)}
          />
        </Card>
      )}

      {/* Activate the mobile app for this domain — opens the website's pricing/checkout funnel. */}
      <MobileAppAccess domain={domain} deployment={backend} />

      {/* Mailboxes on this domain. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Inbox className="size-4 text-primary" />
            <h3 className="font-semibold text-on-surface">
              Mailboxes <span className="font-normal text-on-surface-variant">({onDomain.length})</span>
            </h3>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={domainUnverified}
              title={domainUnverified ? "Finish this domain's SES + DNS setup first" : undefined}
              onClick={() => setShowImport((v) => !v)}
            >
              <FileSpreadsheet className="size-4" /> Import from Excel
            </Button>
            {onMigrateInto && (
              <Button variant="secondary" size="sm" onClick={() => onMigrateInto(domain)}>
                <ArrowLeftRight className="size-4" /> Import old mail
              </Button>
            )}
          </div>
        </div>

        {domainUnverified && (
          <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn-bright">
            This domain isn't verified for sending yet. Finish its{" "}
            {onRunSetup ? (
              <button onClick={onRunSetup} className="underline underline-offset-2 hover:no-underline">
                SES + DNS setup
              </button>
            ) : (
              <b className="text-on-surface">SES + DNS setup</b>
            )}{" "}
            before adding mailboxes — until it verifies, mail to these addresses won't be delivered.
          </div>
        )}

        {/* Add a mailbox on this domain. */}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            New mailbox
            <span className="flex items-stretch">
              <input
                aria-label={`New mailbox name on ${domain}`}
                value={localPart}
                // Keep only the local part: if someone types a full address out of
                // habit (the domain is already the fixed suffix), drop everything
                // from "@" on so we never build "you@d.com@d.com".
                onChange={(e) => setLocalPart(e.target.value.trim().toLowerCase().replace(/@.*$/, ""))}
                placeholder="you"
                className={cn(inputCls, "w-40 rounded-r-none")}
                {...noAutoCap}
              />
              <span className="flex items-center rounded-r-lg border border-l-0 border-outline-variant/30 bg-surface-container-highest/40 px-3 font-mono text-sm text-on-surface-variant">
                @{domain}
              </span>
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            Password
            <input
              aria-label="New mailbox password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={cn(inputCls, "w-56")}
            />
          </label>
          <Button onClick={() => void createMb()} disabled={mbBusy || !localPart || !password || domainUnverified}>
            {mbBusy ? <Spinner className="border-white/40 border-t-white" /> : <Plus className="size-4" />}
            {mbBusy ? "Creating…" : "Create mailbox"}
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-on-surface-variant/70">
          Password must meet the pool policy (min 8 chars, with upper &amp; lower case, a number and a symbol).
        </p>

        {mbCreated && (
          <div className="mt-3 rounded-lg border border-secondary/30 bg-secondary/10 p-3 text-sm text-on-surface">
            ✅ Mailbox <b>{mbCreated}</b> created. Open the <b>Inbox</b> tab and sign in as{" "}
            <code className="font-mono text-xs">{mbCreated}</code>.
          </div>
        )}
        {mbError && (
          <div className="mt-3 rounded-lg border border-tertiary/30 bg-tertiary-container/10 p-3 text-sm text-tertiary">
            {mbError}
          </div>
        )}

        {/* Bulk import from a spreadsheet — opens under the single-create form,
            and only when the domain is verified for sending (same gate). */}
        {showImport && !domainUnverified && (
          <div className="mt-4">
            <MailboxImport
              domain={domain}
              stackName={stackName}
              onImported={() => setReloadKey((k) => k + 1)}
            />
          </div>
        )}

        <div className="mt-4">
          {onDomain.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No mailboxes on this domain yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {onDomain.map((m) => (
                <MailboxStorageRow
                  key={m.email}
                  email={m.email}
                  status={m.status}
                  stackName={stackName}
                  onDeleted={() => setReloadKey((k) => k + 1)}
                  onOpenInbox={onOpenInbox}
                />
              ))}
            </ul>
          )}
          {backend && (
            <p className="mt-3 font-mono text-xs text-on-surface-variant/70">
              backend {stackName} · pool {backend.userPoolId} · {backend.region}
            </p>
          )}
        </div>
      </Card>

      {/* Import old mail into this domain. */}
      {onMigrateInto && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Mail className="size-4 text-primary" />
              <div>
                <h3 className="font-semibold text-on-surface">Import old mail</h3>
                <p className="mt-0.5 text-sm text-on-surface-variant">
                  Bring mail across from another IMAP mailbox into a mailbox on {domain}.
                </p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => onMigrateInto(domain)}>
              <ArrowLeftRight className="size-4" /> Open migration
            </Button>
          </div>
        </Card>
      )}

      {/* Per-domain mail rules + retention. Each writes a `<kind>#<domain>`
          override; the inbound-processor / janitor fall back to the deployment
          default for any domain that hasn't set one. */}
      <Card>
        <PolicyEditor stackName={stackName} domain={domain} />
      </Card>
      <Card>
        <RetentionEditor stackName={stackName} domain={domain} />
      </Card>

      {/* Danger zone — remove just THIS domain (mailboxes + mail + SES + DNS),
          leaving the shared backend and other domains intact. */}
      <div className="overflow-hidden rounded-xl border border-error/20 bg-error/10">
        <button
          type="button"
          aria-label="Toggle danger zone"
          aria-expanded={dangerOpen}
          onClick={() => setDangerOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-4 p-6 text-left"
        >
          <div>
            <div className="mb-1 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-error">
              <AlertTriangle className="size-4" />
              Danger zone
            </div>
            <h3 className="text-lg font-semibold text-on-surface">Remove this domain</h3>
            {!dangerOpen && (
              <p className="mt-1 text-sm text-on-surface-variant">
                Permanently delete <code className="font-mono text-tertiary">{domain}</code> — its mailboxes &amp;
                their mail, its mail rules, SES identity and DNS. Other domains and the backend stay.
              </p>
            )}
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-error/20 bg-error/5 px-3 py-1.5 text-sm font-medium text-error">
            {dangerOpen ? (
              <>
                Hide <ChevronUp className="size-4" />
              </>
            ) : (
              <>
                Show <ChevronDown className="size-4" />
              </>
            )}
          </span>
        </button>

        {dangerOpen && (
          <div className="border-t border-error/10 p-6 pt-5">
            <p className="text-sm text-on-surface-variant">
              Permanently delete everything for <code className="font-mono text-tertiary">{domain}</code>: its{" "}
              <b className="text-on-surface">mailboxes and all their stored mail</b>, this domain's mail rules &amp;
              retention, its <b className="text-on-surface">SES identity</b> and its{" "}
              <b className="text-on-surface">DNS records</b> (MX/DKIM/DMARC/SPF). The shared backend and your other
              domains are <b className="text-on-surface">not</b> touched.{" "}
              <b className="text-tertiary">This cannot be undone.</b>
            </p>

            <div className="mt-3 text-sm text-on-surface-variant">
              {onDomain.length > 0 ? (
                <>
                  <b className="text-on-surface">
                    This deletes {onDomain.length} mailbox{onDomain.length === 1 ? "" : "es"} on {domain} and their
                    mail:
                  </b>
                  <ul className="mt-1 list-disc pl-5 font-mono text-xs">
                    {onDomain.map((m) => (
                      <li key={m.email}>{m.email}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <>No mailboxes on this domain — only its SES identity and DNS will be removed.</>
              )}
            </div>

            {removeResult ? (
              <div className="mt-4 rounded-lg border border-secondary/30 bg-secondary/10 p-4">
                <strong className="text-secondary">Removed {removeResult.domain}.</strong>
                <ul className="mt-1.5 list-disc pl-5 text-xs text-on-surface-variant">
                  <li>
                    {removeResult.deletedMailboxes.length} mailbox(es), {removeResult.deletedMessages} message(s),{" "}
                    {removeResult.deletedObjects} file(s) deleted
                  </li>
                  <li>SES identity {removeResult.sesIdentityDeleted ? "deleted" : "already gone"}</li>
                  <li>{removeResult.dnsRemoved.length} DNS record change(s)</li>
                </ul>
                {removeResult.warnings.length > 0 && (
                  <div className="mt-2 text-sm text-warn">
                    <b>Warnings:</b>
                    <ul className="mt-1 list-disc pl-5">
                      {removeResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {onBack && (
                  <Button variant="secondary" className="mt-3" onClick={onBack}>
                    <ArrowLeft className="size-4" /> Back to overview
                  </Button>
                )}
              </div>
            ) : removing ? (
              <div className="mt-4 flex items-center gap-2 text-sm text-on-surface-variant">
                <Spinner /> Removing {domain}…
              </div>
            ) : (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="text-sm text-on-surface-variant">
                  <span className="mb-1 block">
                    Type <code className="font-mono text-tertiary">{domain}</code> to confirm
                  </span>
                  <input
                    aria-label="Type domain to confirm removal"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={domain}
                    {...noAutoCap}
                    className="w-64 rounded-lg border border-error/30 bg-surface-container-lowest px-3 py-2 font-mono text-sm text-on-surface placeholder:text-outline-variant focus:border-error focus:outline-none focus:ring-2 focus:ring-error/30"
                  />
                </label>
                <Button variant="danger" disabled={!canRemove} onClick={() => void onRemove()}>
                  <Trash2 className="size-4" /> Remove domain
                </Button>
              </div>
            )}

            {removeErr && <div className="mt-3 text-sm text-tertiary">Remove failed: {removeErr}</div>}
          </div>
        )}
      </div>

      <p className="text-xs text-on-surface-variant/70">
        To tear down the <b className="text-on-surface">whole backend</b> (every domain, all mailboxes and the AWS
        resources), remove each domain first — once none remain, a{" "}
        <b className="text-on-surface">Remove leftover infrastructure</b> option appears on the overview.
      </p>
    </div>
  );
}
