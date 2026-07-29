import { useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, ShieldCheck, Rocket, Globe, RefreshCw, Mail, Sparkles, ArrowLeft, Lock } from "lucide-react";
import { sidecar } from "../lib/sidecar";
import { createMailbox, listMailboxes, type Mailbox, type BackendInfo } from "../lib/mailbox";
import { deployBackend, deployStatus, type DeployStatus } from "../lib/deploy";
import { validateTestRecipient } from "../lib/deliverability";
import { saveDeploymentConfig, loadDeploymentConfig, resolveStackName, DEFAULT_STACK_NAME } from "../lib/deploymentConfig";
import { MailboxStorageRow } from "./MailboxStorageRow";
import { AppAccessDriftNotice } from "./AppAccessDriftNotice";
import { MailFromSetup } from "./MailFromSetup";
import { RegionPicker } from "./RegionPicker";
import { AwsOnboarding } from "./AwsOnboarding";
import { friendlyError } from "../lib/errors";
import { AdminPrivacyNotice } from "./AdminPrivacyNotice";
import { SetupProgress } from "./SetupProgress";
import { deriveResume, setupPhases, type SetupStep } from "../lib/setupProgress";
import { Card, Button, Spinner, cn } from "../ui";

// Phase 1 setup wizard.
// Step 0 verifies the AWS environment (credentials + per-service permissions, + detects
// the optional CLI) so provisioning never fails halfway. Then, once ready:
//   1. preflight → 2. provision → poll DKIM → 3. send deliverability test.
// A "Mailboxes" section manages Cognito users in the deployed backend.

interface Readiness {
  cli: { installed: boolean; version?: string };
  credentials: { ok: boolean; arn?: string; account?: string; error?: string };
  permissions: Record<"route53" | "ses" | "sesv2" | "s3", "ok" | "denied" | "error">;
  ready: boolean;
}
interface Preflight {
  accountId: string;
  zoneId: string;
  region: string;
}
interface ProvisionResult {
  ok: boolean;
  dkimTokens: string[];
}
interface IdentityStatus {
  verifiedForSending: boolean;
  dkim: string;
}

// The wizard's step machine is shared with the (pure, tested) progress model so
// the two never drift — see ../lib/setupProgress.
type Step = SetupStep;
const SERVICES = ["route53", "ses", "sesv2", "s3"] as const;
// Plain-language names for the AWS services MailPoppy needs access to — the raw
// service ids (route53/ses/sesv2/s3) are AWS jargon, so they're shown only as a
// hover title for anyone who wants the technical name.
const SERVICE_LABEL: Record<(typeof SERVICES)[number], { name: string; does: string }> = {
  route53: { name: "Your domain's DNS", does: "read and update your domain's DNS records" },
  ses: { name: "Sending email", does: "send email from your domain" },
  sesv2: { name: "Email settings", does: "manage your domain's email settings" },
  s3: { name: "Mail storage", does: "store your mail" },
};

/** Remember the typed-but-not-yet-submitted domain so a remount/HMR/restart
 *  doesn't lose it before there's anything in AWS to resume from. */
const DOMAIN_DRAFT_KEY = "mailpoppy.setup.domainDraft";
function readDomainDraft(): string {
  try {
    return localStorage.getItem(DOMAIN_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

const noAutoCap = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false, autoComplete: "off" } as const;

/** The domain part of an email address, lower-cased (mirrors DomainView/HomeView). */
const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

const inputCls =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface placeholder:text-outline-variant transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";

/** Inline code chip. */
function C({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-container-lowest px-1 py-0.5 font-mono text-[0.85em] text-on-surface-variant">{children}</code>;
}

/** A numbered step card with the accent bar + "STEP" pill from the Stitch design. */
function StepCard({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-outline-variant/10 bg-surface-container p-6 shadow-lg shadow-black/20">
      <span aria-hidden className="absolute left-0 top-0 h-full w-1 bg-primary-container" />
      <div className="mb-4 flex items-center gap-3">
        <span className="rounded-full border border-primary/30 bg-primary-container/20 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-primary">
          {step}
        </span>
        <h2 className="text-lg font-semibold text-on-surface">{title}</h2>
      </div>
      {children}
    </div>
  );
}

/** Mint "ok" pill used for verified dependencies. */
function OkBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-secondary/20 bg-secondary/10 px-3 py-1 font-mono text-xs text-secondary">
      <ShieldCheck className="size-3.5" /> {children}
    </span>
  );
}

/** A warning callout (amber). */
function Warn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-warn/30 bg-warn/10 p-4 text-sm text-warn-bright", className)}>{children}</div>;
}

const permTone = (v: "ok" | "denied" | "error") =>
  v === "ok"
    ? "border-secondary/20 bg-secondary/10 text-secondary"
    : v === "denied"
      ? "border-tertiary/30 bg-tertiary-container/15 text-tertiary"
      : "border-warn/30 bg-warn/10 text-warn";
const permIcon = (v: "ok" | "denied" | "error") => (v === "ok" ? "✓" : v === "denied" ? "⛔" : "⚠");

export function SetupWizard({
  presetDomain,
  onExit,
}: {
  // When set, this is a re-run for an existing domain: the domain is fixed.
  presetDomain?: string;
  onExit?: () => void;
} = {}) {
  // Step 0 — environment readiness
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [checking, setChecking] = useState(true);
  const retryRef = useRef<number | null>(null);

  // The backend stack is deployed once (with the first domain). For every
  // subsequent domain — and for any re-run — it already exists, so the deploy
  // step is skipped and we go straight from preflight to provisioning DNS/SES.
  // localStorage hint (can be stale: a torn-down stack may leave it behind, or a
  // fresh install may lack it). `liveDeployed` is the authoritative truth from a
  // live listMailboxes during reconcile; prefer it once known.
  const localConfigDeployed = !!loadDeploymentConfig();
  const [liveDeployed, setLiveDeployed] = useState<boolean | null>(null);
  const [reconciling, setReconciling] = useState(true);
  const [leftover, setLeftover] = useState(false);
  const backendDeployed = liveDeployed ?? localConfigDeployed;

  // Steps 1–3
  const [domain, setDomain] = useState(presetDomain ?? readDomainDraft());
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState<Step>("start");
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  // Fire the resume auto-preflight at most once, so reopening a deployed domain lands
  // the user on the real next action instead of a bare "check" button.
  const autoPreflightedRef = useRef(false);
  // A soft warning when the read-only pre-check couldn't fully confirm the domain
  // (most often: no Route53 hosted zone for it yet). It must NOT block creating the
  // backend — the backend doesn't need the zone — so we surface it and let the user proceed.
  const [preflightWarn, setPreflightWarn] = useState<string | null>(null);
  const [provision, setProvision] = useState<ProvisionResult | null>(null);
  const [status, setStatus] = useState<IdentityStatus | null>(null);
  const [messageId, setMessageId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);
  // In-app confirmation. Tauri's webview (WKWebView on macOS) doesn't reliably
  // show the native window.confirm() dialog — it just returns false — so a
  // confirm-gated action would silently do nothing. We render our own dialog.
  const [confirmAction, setConfirmAction] = useState<null | { message: string; run: () => void }>(null);

  // Backend deploy (CloudFormation)
  const [deploy, setDeploy] = useState<DeployStatus | null>(null);
  const [enableMalware, setEnableMalware] = useState(true); // recommended → default on
  const [encryptAtRest, setEncryptAtRest] = useState(true); // security-on-by-default; admin can opt out (clients must be able to decrypt)
  const deployPollRef = useRef<number | null>(null);
  // For distinguishing this deploy from a leftover stack of the same name that a
  // prior failed attempt left behind (which is being deleted + recreated).
  const priorStackIdRef = useRef<string | null>(null);
  const deployOpRef = useRef<string | null>(null);

  // Mailboxes. The backend's stack name is resolved (one backend per install),
  // not typed — there's no editable stack-name field anymore.
  const stackName = resolveStackName();
  // The first mailbox is always on the domain just set up, so we collect only the
  // local part and append "@domain" — the user can't misspell the domain, and
  // doesn't retype what they already entered above (mirrors DomainView).
  const [mbLocalPart, setMbLocalPart] = useState("");
  const [mbPassword, setMbPassword] = useState("");
  const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
  const [mbBackend, setMbBackend] = useState<BackendInfo | null>(null);
  const [mbBusy, setMbBusy] = useState(false);
  const [mbError, setMbError] = useState<string | null>(null);
  const [mbNoBackend, setMbNoBackend] = useState(false);
  const [mbCreated, setMbCreated] = useState<string | null>(null);

  // The sidecar may still be booting when the view mounts; retry a few times
  // before declaring it unreachable so the user sees a loader, not an error.
  async function loadReadiness(attempt = 0) {
    setChecking(true);
    setError(null);
    try {
      setReadiness(await sidecar<Readiness>("/aws/readiness"));
      setChecking(false);
    } catch (e) {
      if (attempt < 8) {
        retryRef.current = window.setTimeout(() => void loadReadiness(attempt + 1), 1200);
      } else {
        setError(
          `Could not reach the local provisioning helper after several tries. Make sure the app's sidecar is running (it starts automatically with the desktop app). ${friendlyError(e)}`,
        );
        setChecking(false);
      }
    }
  }
  useEffect(() => {
    void loadReadiness();
    return () => {
      if (retryRef.current) window.clearTimeout(retryRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fail(e: unknown, back?: Step) {
    setError(friendlyError(e));
    setBusy(false);
    if (back) setStep(back);
  }

  function askConfirm(message: string, run: () => void) {
    setConfirmAction({ message, run });
  }

  async function runPreflight(forDomain?: string) {
    const d = forDomain ?? domain;
    setError(null);
    setPreflightWarn(null);
    setBusy(true);
    try {
      setPreflight(await sidecar<Preflight>(`/aws/preflight/${encodeURIComponent(d)}`));
      setStep("preflighted");
    } catch (e) {
      // A failed pre-check must NOT strand the user at "Create your backend" with
      // no trigger. Creating the backend needs only the domain — never the hosted
      // zone (that's the later SES + DNS step) — so we still advance to
      // "preflighted" and show the deploy action, surfacing a soft warning rather
      // than a dead-end. Credentials are already validated at Step 0, so a failure
      // here is almost always a missing/again-pending Route53 zone.
      setPreflight(null);
      setPreflightWarn(friendlyError(e));
      setStep("preflighted");
    } finally {
      setBusy(false);
    }
  }

  // Step 2 — deploy the full backend stack via CloudFormation (no terminal/cdk).
  function onDeploy() {
    askConfirm(
      `Set up your email service for ${domain} in your AWS account? This creates the things your email needs to run — real AWS resources that you own — and takes about 1–3 minutes.`,
      runDeploy,
    );
  }
  async function runDeploy() {
    setError(null);
    setBusy(true);
    setStep("deploying");
    try {
      // Note the pre-existing stack (a prior failed attempt leaves a
      // ROLLBACK_COMPLETE stack of the same name) so the poll can tell that
      // leftover apart from the stack we're about to create, and not mistake the
      // old failure for this deploy's outcome.
      const before = await deployStatus(DEFAULT_STACK_NAME).catch(() => null);
      priorStackIdRef.current = before?.stackId ?? null;
      const started = await deployBackend({ domain, enableMalwareProtection: enableMalware, enableEncryption: encryptAtRest });
      deployOpRef.current = started.operation;
    } catch (e) {
      fail(e, "preflighted");
      return;
    } finally {
      setBusy(false);
    }
  }

  // Poll the deploy until the stack settles; on success persist the client config.
  // Resilience matters here: a single bad read must NOT strand the user on a false
  // error that "fixes itself" on restart. Two guards:
  //   • a failed status for the *leftover* prior stack (same name, same id, while
  //     it's being deleted + recreated) is ignored — that's not this deploy.
  //   • transient read errors are retried a few times before being surfaced.
  useEffect(() => {
    if (step !== "deploying") return;
    let cancelled = false;
    let errors = 0;
    let staleWaits = 0;
    async function poll() {
      try {
        const s = await deployStatus("MailpoppyMailStack");
        if (cancelled) return;
        errors = 0;
        setDeploy(s);
        if (s.failed) {
          // Is this the pre-existing stack we're replacing, not the new deploy?
          // (Only on a create/recreate, and only while we still see the SAME
          // stack id we saw before starting.) If so, the recreate just hasn't
          // surfaced yet — keep waiting instead of reporting a phantom failure.
          const op = deployOpRef.current;
          const isLeftover =
            (op === "CREATE" || op === "RECREATE") && !!s.stackId && s.stackId === priorStackIdRef.current;
          if (isLeftover && staleWaits < 30) {
            staleWaits += 1;
            deployPollRef.current = window.setTimeout(poll, 4000);
            return;
          }
          setError(`Backend deploy failed (${s.status})${s.reason ? `: ${s.reason}` : ""}.`);
          setStep("preflighted");
          return;
        }
        if (s.complete) {
          const o = s.outputs ?? {};
          if (o.ApiBaseUrl && o.UserPoolId && o.UserPoolClientId) {
            saveDeploymentConfig({
              apiBaseUrl: o.ApiBaseUrl,
              userPoolId: o.UserPoolId,
              clientId: o.UserPoolClientId,
              region: o.DeployRegion || "eu-west-1",
              stackName: DEFAULT_STACK_NAME,
            });
          }
          setStep("deployed");
          return;
        }
      } catch (e) {
        if (cancelled) return;
        // A one-off read failure (sidecar momentarily busy, network blip) must not
        // dead-end a deploy that's still running — retry a few times first.
        errors += 1;
        if (errors >= 4) {
          setError(friendlyError(e));
          setStep("preflighted");
          return;
        }
        deployPollRef.current = window.setTimeout(poll, 4000);
        return;
      }
      deployPollRef.current = window.setTimeout(poll, 5000);
    }
    poll();
    return () => {
      cancelled = true;
      if (deployPollRef.current) window.clearTimeout(deployPollRef.current);
    };
  }, [step, domain]);

  function provisionDomain() {
    askConfirm(
      `Set up email for ${domain}? This adds the DNS records that let your domain send and receive mail, in your AWS account.`,
      runProvision,
    );
  }
  async function runProvision() {
    setError(null);
    setBusy(true);
    setStep("provisioning");
    try {
      setProvision(await sidecar<ProvisionResult>(`/provision/${encodeURIComponent(domain)}`, { method: "POST" }));
      setStep("verifying");
    } catch (e) {
      fail(e, "preflighted");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (step !== "verifying") return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await sidecar<IdentityStatus>(`/provision/${encodeURIComponent(domain)}/status`);
        if (cancelled) return;
        setStatus(s);
        if (s.dkim === "SUCCESS" && s.verifiedForSending) {
          setStep("verified");
          return;
        }
      } catch (e) {
        if (!cancelled) fail(e);
        return;
      }
      pollRef.current = window.setTimeout(poll, 4000);
    }
    poll();
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [step, domain]);

  async function sendTest() {
    setError(null);
    // The deliverability test must go to an EXTERNAL inbox (does our mail reach the
    // outside world?). Block a malformed address or one on the domain being set up.
    const validationError = validateTestRecipient(recipient, domain);
    if (validationError) {
      setError(validationError);
      return;
    }
    const to = recipient.trim().toLowerCase();
    setBusy(true);
    setStep("sending");
    try {
      const r = await sidecar<{ ok: boolean; messageId: string }>(
        `/provision/${encodeURIComponent(domain)}/test`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to }) },
      );
      setMessageId(r.messageId);
      setStep("sent");
    } catch (e) {
      fail(e, "verified");
    } finally {
      setBusy(false);
    }
  }

  const ready = readiness?.ready === true;
  // A mailbox is a Cognito user in the deployed backend, scoped to this domain,
  // so it can only be created once the backend exists AND the domain has verified.
  // Until then the Mailboxes section is shown as a locked upcoming step (no form),
  // rather than a dead disabled form that reads as a broken dead-end.
  const canAddMailbox = !mbNoBackend && ["verified", "sending", "sent"].includes(step);

  // Every mailbox lives in the one backend user pool, but THIS is a per-domain setup
  // view: it must only ever show and count the mailboxes on the domain being set up —
  // never another domain's (e.g. don't surface youord.com's mailbox while setting up
  // boxord.com). Account-wide mailbox management lives in each domain's own view.
  const domainMailboxes = (mailboxes ?? []).filter((m) => domainOf(m.email) === domain.toLowerCase());

  // The always-visible progress map (right rail). The "backend is live" claim
  // MUST come from live truth (a confirmed listMailboxes), never the localStorage
  // hint — otherwise a torn-down backend whose credentials are gone (so
  // listMailboxes can't even run, leaving liveDeployed === null) would still show
  // "your backend is live" from a stale flag. An in-session post-deploy step is
  // covered separately inside setupPhases via the step value. mailboxCount is scoped
  // to THIS domain so "Create your first mailbox" reflects this domain, not the pool.
  const phases = setupPhases({ ready, step, backendDeployed: liveDeployed === true, mailboxCount: domainMailboxes.length });

  // ---- Mailboxes ----
  async function loadMailboxes(): Promise<{ deployed: boolean; backend: BackendInfo | null; mailboxes: Mailbox[] }> {
    setMbError(null);
    setMbNoBackend(false);
    try {
      const res = await listMailboxes(stackName);
      const backend = { region: res.region, userPoolId: res.userPoolId, clientId: res.clientId, apiBaseUrl: res.apiBaseUrl };
      setMailboxes(res.mailboxes);
      setMbBackend(backend);
      setLiveDeployed(true);
      return { deployed: true, backend, mailboxes: res.mailboxes };
    } catch (e) {
      setMailboxes(null);
      setMbBackend(null);
      const msg = String(e);
      // A 404 here just means the backend stack isn't deployed yet — the
      // expected state on first launch, not an error. Show the deploy hint
      // instead of an alarming red banner.
      if (/\b404\b/.test(msg) && /No deployed MailPoppy backend/i.test(msg)) {
        setMbNoBackend(true);
        setLiveDeployed(false);
      } else {
        setMbError(friendlyError(e));
      }
      return { deployed: false, backend: null, mailboxes: [] };
    }
  }
  // On ready, reconcile from REAL AWS state so the wizard resumes exactly where
  // the user left off — even after closing and reopening the app — instead of a
  // blank form that pretends nothing was done.
  useEffect(() => {
    if (ready) void reconcile();
    else setReconciling(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, stackName]);

  // Persist the typed-but-not-submitted domain so a remount/HMR/restart doesn't
  // lose it before there's anything in AWS to resume from. (A re-run is pinned.)
  useEffect(() => {
    if (presetDomain) return;
    try {
      if (domain) localStorage.setItem(DOMAIN_DRAFT_KEY, domain);
      else localStorage.removeItem(DOMAIN_DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }, [domain, presetDomain]);

  // Resume from reality: query the live backend, its domains, and the candidate
  // domain's verification status, then drop the user at the right step. Only
  // advances from "start", so it never overrides a flow the user is mid-way through.
  async function reconcile() {
    setReconciling(true);
    try {
      const { deployed, backend } = await loadMailboxes();

      // Background-resume: if a deploy is STILL running server-side (its CloudFormation
      // stack is mid-create), drop the user straight back onto the live progress. The
      // deploy poller re-attaches itself purely from step === "deploying", so this is all
      // it takes for "leave the screen, the deploy keeps running, come back to its status".
      if (!deployed) {
        const inFlight = await deployStatus(stackName).catch(() => null);
        if (inFlight && /_IN_PROGRESS$/i.test(inFlight.status ?? "")) {
          setDeploy(inFlight);
          setStep((cur) => (cur === "start" ? "deploying" : cur));
          return;
        }
      }

      let domains: string[] = [];
      try {
        const d = await sidecar<{ ok: boolean; domains: string[] }>(`/teardown/domains/${encodeURIComponent(stackName)}`);
        domains = d.domains ?? [];
      } catch {
        /* discovery is best-effort */
      }

      const candidate = presetDomain || domains[0] || "";
      let dkim: string | undefined;
      let verifiedForSending: boolean | undefined;
      if (candidate) {
        try {
          const s = await sidecar<IdentityStatus>(`/provision/${encodeURIComponent(candidate)}/status`);
          dkim = s.dkim;
          verifiedForSending = s.verifiedForSending;
        } catch {
          /* status is best-effort */
        }
      }

      const r = deriveResume({ backendDeployed: deployed, domains, dkim, verifiedForSending, presetDomain });
      setLeftover(r.leftover);
      if (r.domain) {
        setDomain(r.domain);
      } else if (!presetDomain) {
        // Adding a NEW domain with nothing in-progress to resume: clear a stale draft
        // left by a just-finished domain so the form starts empty. Only clear a draft
        // that matches an already-set-up domain, so a value the user just typed is kept.
        setDomain((cur) => (domains.some((d) => d.toLowerCase() === cur.trim().toLowerCase()) ? "" : cur));
      }

      // Reconstruct just enough so the resumed step's panels render — the data
      // those panels read normally comes from in-session API calls.
      if (deployed && backend) {
        setDeploy({
          status: "CREATE_COMPLETE",
          complete: true,
          failed: false,
          outputs: {
            ApiBaseUrl: backend.apiBaseUrl,
            UserPoolId: backend.userPoolId,
            UserPoolClientId: backend.clientId,
            DeployRegion: backend.region,
          },
        });
      }

      setStep((cur) => (cur === "start" ? r.step : cur));

      // Resume convenience: whenever we resume with a KNOWN domain — a re-run pinned
      // to a domain, or leftover DNS from a prior setup — run the AWS/DNS check for the
      // user so they land straight on the real next action instead of a bare "Continue"
      // button they have to discover. With the backend already deployed that's "Set up
      // domain mail"; without it (a half-finished setup) it's "Deploy backend", so a
      // resumed-but-undeployed domain isn't stranded at "Create your backend" with no
      // trigger. Once only, and only on resume — the r.domain guard leaves a brand-new
      // setup (nothing typed yet) untouched so it never preflights an empty domain.
      if (r.domain && r.step === "start" && !autoPreflightedRef.current) {
        autoPreflightedRef.current = true;
        void runPreflight(r.domain);
      }
    } finally {
      setReconciling(false);
    }
  }

  // After an in-session deploy finishes, the backend stack now exists. The
  // effect above already ran (and 404'd) before the stack was created, so
  // re-query here to clear the stale "no backend yet" state and enable
  // "Create mailbox" — without forcing an app restart.
  useEffect(() => {
    if (ready && step === "deployed") void loadMailboxes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function createMb() {
    const local = mbLocalPart.trim().toLowerCase();
    if (!local || !mbPassword) return;
    const email = `${local}@${domain}`;
    setMbBusy(true);
    setMbError(null);
    setMbCreated(null);
    try {
      const res = await createMailbox({ email, password: mbPassword, stackName });
      setMbCreated(res.mailbox.email);
      setMbLocalPart("");
      setMbPassword("");
      // Persist the backend config so the Inbox tab is ready to sign in.
      if (res.apiBaseUrl && res.userPoolId && res.clientId) {
        saveDeploymentConfig({
          apiBaseUrl: res.apiBaseUrl,
          userPoolId: res.userPoolId,
          clientId: res.clientId,
          region: res.region,
          stackName,
        });
      }
      await loadMailboxes();
    } catch (e) {
      setMbError(friendlyError(e));
    } finally {
      setMbBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* In-app confirmation dialog (native window.confirm is unreliable in the
          Tauri webview). */}
      {confirmAction && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-[1000] flex items-center justify-center bg-base/80 p-4">
          <div className="w-full max-w-md rounded-xl border border-outline-variant/20 bg-surface-container p-6 shadow-2xl">
            <p className="mb-5 text-sm leading-relaxed text-on-surface">{confirmAction.message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmAction(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const run = confirmAction.run;
                  setConfirmAction(null);
                  run();
                }}
              >
                Yes, continue
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Intro */}
      <div>
        {onExit && (
          <button
            onClick={onExit}
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-on-surface-variant transition-colors hover:text-on-surface"
          >
            <ArrowLeft className="size-4" /> Back to overview
          </button>
        )}
        <div className="font-mono text-xs uppercase tracking-wider text-primary">
          {presetDomain ? "Domain setup" : "Add a domain"}
        </div>
        <h2 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <Sparkles className="size-5 text-primary" />
          {presetDomain ? `Set up ${presetDomain}` : "Set up a new domain"}
        </h2>
        <p className="mt-1 max-w-2xl text-on-surface-variant">
          {backendDeployed
            ? "Add the DNS records that let this domain send and receive email — all inside your own AWS account, so your mail stays yours. Nothing leaves this computer."
            : "Set up everything your email needs — the service that runs it, and your domain's DNS records — all inside your own AWS account, so your mail stays yours. Nothing leaves this computer."}
        </p>
      </div>

      {/* The compact progress stepper is pinned at the TOP of the view: the user
          sees the whole journey first, then the controls follow directly below it
          — so the active step's action is never above its own progress map. */}
      <div className="sticky top-0 z-10 bg-base pb-1 pt-0.5">
        <SetupProgress phases={phases} reconciling={reconciling} />
      </div>

      <div className="flex flex-col gap-6">
          {/* ---- Data residency: choose the AWS region ---- */}
          <Card>
            <RegionPicker lockedRegion={loadDeploymentConfig()?.region} />
          </Card>

      {/* ---- Step 0: AWS environment ---- */}
      <StepCard step="Step 0" title="Your AWS account">
        {checking && (
          <div className="flex items-center gap-2 text-sm text-on-surface-variant">
            <Spinner /> Getting ready and checking your AWS account…{" "}
            <span className="text-on-surface-variant/60">(this can take a few seconds)</span>
          </div>
        )}
        {readiness && (
          <div className="flex flex-col gap-3 text-sm">
            {/* The AWS CLI is optional — provisioning runs entirely through the SDK, so
                its presence never gates readiness. We deliberately don't render it as a
                status row: for newcomers using the in-app key entry it reads as "something
                is missing" when nothing is. `readiness.cli` stays in the payload (the
                onboarding panel's Advanced hint reads `cliInstalled`) so a future version
                can resurface it without re-plumbing. */}
            {/* Credentials */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-outline-variant/10 bg-surface-container-lowest p-3">
              <span className="flex items-center gap-2 text-on-surface-variant">
                <KeyRound className="size-4" /> Connection
              </span>
              {readiness.credentials.ok ? (
                <span className="flex items-center gap-2">
                  <OkBadge>Connected</OkBadge>
                  {readiness.credentials.account && (
                    <span className="font-mono text-xs text-on-surface-variant" title={readiness.credentials.arn}>
                      account {readiness.credentials.account}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-tertiary">
                  ⛔ We couldn&apos;t reach your AWS account yet
                  {readiness.credentials.error ? ` — ${readiness.credentials.error}` : ""}
                </span>
              )}
            </div>
            {/* What MailPoppy can do — plain-language capability names, raw service id on hover. */}
            {readiness.credentials.ok && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-on-surface-variant">What MailPoppy can do:</span>
                {SERVICES.map((k) => (
                  <span
                    key={k}
                    title={`AWS ${k} — ${SERVICE_LABEL[k].does}`}
                    className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs", permTone(readiness.permissions[k]))}
                  >
                    {permIcon(readiness.permissions[k])} {SERVICE_LABEL[k].name}
                  </span>
                ))}
              </div>
            )}

            {/* No usable credentials → the guided "connect your AWS account" panel
                (create an account + IAM keys, or paste keys you already have).
                Power-user CLI/SSO guidance lives under its "Advanced" disclosure. */}
            {!ready && !readiness.credentials.ok && (
              <AwsOnboarding
                onResult={(r) => setReadiness(r)}
                onRecheck={() => void loadReadiness()}
                cliInstalled={readiness.cli.installed}
              />
            )}
            {/* Credentials resolve but a service permission is missing. */}
            {!ready && readiness.credentials.ok && (
              <Warn>
                <b>Almost there — MailPoppy is missing some access:</b>
                <ul className="ml-4 mt-1.5 list-disc space-y-2">
                  {SERVICES.filter((k) => readiness.permissions[k] !== "ok").map((k) => (
                    <li key={k}>
                      <b>{SERVICE_LABEL[k].name}</b> — MailPoppy{" "}
                      {readiness.permissions[k] === "denied" ? "isn't allowed to" : "couldn't check whether it can"}{" "}
                      {SERVICE_LABEL[k].does}.
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  The quickest fix is to give this AWS user full access — attach the{" "}
                  <b>AdministratorAccess</b> policy in AWS — then re-check.{" "}
                  <span className="text-on-surface-variant/70" title={readiness.credentials.arn}>
                    (Applies to the AWS user you connected.)
                  </span>
                </p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadReadiness()} disabled={checking}>
                  <RefreshCw className="size-3.5" /> Re-check
                </Button>
              </Warn>
            )}
            {ready && (
              <div className="flex items-center gap-2 font-medium text-secondary">
                <ShieldCheck className="size-4" /> Your AWS account is connected and ready — let&apos;s set up your domain.
              </div>
            )}
          </div>
        )}
      </StepCard>

      {/* ---- Steps 1–4 (gated on readiness) ---- */}
      <StepCard step="Steps 1–4" title="Set up a domain">
        {!ready && <p className="mb-3 text-sm text-on-surface-variant">Connect your AWS account above first.</p>}
        {ready && leftover && (
          <Warn className="mb-3">
            We found DNS records for <b>{domain}</b> from an earlier setup, but your email service isn&apos;t running yet.
            Set it up below — the existing records are reused, so you won&apos;t get duplicates.
          </Warn>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            Domain
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value.trim().toLowerCase())}
              placeholder="yourdomain.com"
              disabled={!ready || step !== "start" || !!presetDomain}
              className={cn(inputCls, "w-64")}
              {...noAutoCap}
            />
          </label>
          <Button onClick={() => void runPreflight()} disabled={!ready || !domain || busy || step !== "start"}>
            <Globe className="size-4" /> Continue
          </Button>
        </div>

        {/* Plain confirmation up front; the raw ids live in a "Technical details"
            disclosure for anyone who wants them. The actions below don't depend on it. */}
        {preflight && (
          <div className="mt-4 text-sm">
            <div className="flex items-center gap-1.5 text-secondary">
              <ShieldCheck className="size-4" /> Found your AWS account and your domain&apos;s DNS — ready to set up email.
            </div>
            <details className="mt-1.5 text-xs text-on-surface-variant/80">
              <summary className="cursor-pointer select-none hover:text-on-surface-variant">Technical details</summary>
              <div className="mt-1.5 flex flex-col gap-1 font-mono">
                <span>account {preflight.accountId} · region {preflight.region}</span>
                <span>DNS zone {preflight.zoneId}</span>
              </div>
            </details>
          </div>
        )}

        {/* The pre-check couldn't fully confirm the domain (most often: no Route53
            hosted zone for it yet). That must NOT block creating the backend — the
            backend doesn't need the zone — so explain it and let the user proceed. */}
        {step === "preflighted" && preflightWarn && (
          <Warn className="mt-4">
            <b>We couldn&apos;t finish checking {domain} yet:</b> {preflightWarn} You can still set up your email service
            now — but before the next step (your domain&apos;s email), {domain} needs its{" "}
            <b>DNS hosted in this AWS account</b> (in Route&nbsp;53). Sort that out and come back.
          </Warn>
        )}

        {/* Create the backend stack. Reachable whenever the backend isn't live yet
            and we've reached this step — deploying needs only the domain, never the
            hosted zone, so a failed/again-pending pre-check never strands it here. */}
        {step === "preflighted" && !backendDeployed && (
          <div className="mt-4">
            <label className="mb-3 flex max-w-lg items-start gap-2 text-sm text-on-surface-variant">
              <input type="checkbox" checked={enableMalware} onChange={(e) => setEnableMalware(e.target.checked)} className="mt-1 size-4 accent-primary" />
              <span>
                <b className="text-on-surface">Scan attachments for viruses</b> <span className="text-secondary">(recommended)</span> —
                checks files for malware before anyone can download them. There&apos;s a small AWS cost, but it&apos;s usually
                free for a personal mailbox.
              </span>
            </label>
            <label className="mb-3 flex max-w-lg items-start gap-2 text-sm text-on-surface-variant">
              <input type="checkbox" checked={encryptAtRest} onChange={(e) => setEncryptAtRest(e.target.checked)} className="mt-1 size-4 accent-primary" />
              <span>
                <b className="text-on-surface">Lock each mailbox with its owner&apos;s password</b>{" "}
                <span className="text-secondary">(recommended)</span> — so even you, the account owner, can&apos;t read
                someone&apos;s email. Only turn this off if some people will read their mail in an older MailPoppy app that
                can&apos;t open locked mail. The subject and sender stay visible either way.
              </span>
            </label>
            <Button onClick={onDeploy} disabled={busy}>
              <Rocket className="size-4" /> Set up email service
            </Button>
          </div>
        )}

        {/* Backend already exists (additional domain or re-run): skip deploy,
            go straight to provisioning this domain's mail DNS. */}
        {step === "preflighted" && backendDeployed && (
          <div className="mt-4">
            <Button onClick={provisionDomain} disabled={busy}>
              <Globe className="size-4" /> Set up email for this domain
            </Button>
          </div>
        )}

        {step === "deploying" && (
          <div className="mt-4 flex items-center gap-2 text-sm text-on-surface-variant">
            <Spinner /> Setting up your email service…{" "}
            <span className="text-on-surface-variant/60">
              (this usually takes 1–3 minutes, and keeps going in the background — you can leave this screen and come back)
            </span>
          </div>
        )}

        {(step === "deployed" || step === "provisioning" || step === "verifying" || step === "verified" || step === "sending" || step === "sent") &&
          deploy?.outputs?.ApiBaseUrl && (
            <div className="mt-4 text-sm text-on-surface">
              <span className="text-secondary">✅ Your email service is running.</span> The Inbox tab is now connected.
              {step === "deployed" && (
                <div className="mt-3">
                  <Button onClick={provisionDomain} disabled={busy}>
                    <Globe className="size-4" /> Set up email for this domain
                  </Button>
                  {/* If this was a REBUILD (new backend ids), any other domain that was
                      active in the apps now points at the dead old backend — reconcile and
                      warn right here, at the moment the drift is introduced. */}
                  {deploy.outputs.UserPoolId && deploy.outputs.UserPoolClientId && (
                    <div className="mt-3">
                      <AppAccessDriftNotice
                        deployment={{
                          apiBaseUrl: deploy.outputs.ApiBaseUrl,
                          userPoolId: deploy.outputs.UserPoolId,
                          clientId: deploy.outputs.UserPoolClientId,
                          region: deploy.outputs.DeployRegion || "eu-west-1",
                        }}
                        stackName={DEFAULT_STACK_NAME}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        {provision?.ok && (
          <div className="mt-4 text-sm text-secondary">
            ✅ Your domain&apos;s email is set up — the DNS records are published.
          </div>
        )}

        {step === "verifying" && (
          <div className="mt-4 flex items-start gap-2 text-sm text-on-surface-variant">
            <Spinner className="mt-0.5 shrink-0" />
            <span>
              Checking your domain is ready — this usually takes <b className="text-on-surface">a few minutes</b>, occasionally
              up to an hour while your DNS changes spread across the internet. MailPoppy re-checks every few seconds, so you can
              leave this open and come back.
            </span>
          </div>
        )}

        {(step === "verified" || step === "sending" || step === "sent") && (
          <div className="mt-4 text-sm text-on-surface">
            <div className="flex items-center gap-1.5 text-secondary">
              <ShieldCheck className="size-4" /> Your domain is verified — ready to send and receive.
            </div>
            <p className="my-2 text-sm text-on-surface-variant">
              Send a test to a <b className="text-on-surface">personal inbox you can open</b> — e.g. your Gmail or Outlook
              address (not an address on this domain) — and check it lands in your inbox, not spam.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
                Your personal email address
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value.trim().toLowerCase())}
                  placeholder="you@gmail.com"
                  disabled={busy}
                  className={cn(inputCls, "w-64")}
                  {...noAutoCap}
                />
              </label>
              <Button onClick={sendTest} disabled={busy || !recipient}>
                <Mail className="size-4" /> {step === "sent" ? "Send another test" : "Send a test email"}
              </Button>
            </div>
          </div>
        )}

        {step === "sending" && (
          <p className="mt-4 flex items-center gap-2 text-sm text-on-surface-variant">
            <Spinner /> Sending…
          </p>
        )}

        {step === "sent" && (
          <div className="mt-4 text-sm text-on-surface">
            🎉 Sent! Check <b>{recipient}</b> — it should land in your inbox, not spam.
            <p className="mt-2 text-xs text-on-surface-variant">
              Landed in spam instead? That&apos;s normal for a brand-new domain — not a MailPoppy fault. See{" "}
              <b>Sending health</b> for why it happens and how to improve where your mail lands.
            </p>
            <p className="mt-1 text-xs text-on-surface-variant/70">
              Technical check (optional): open <b>Show original</b> in your email and confirm SPF, DKIM and DMARC all say
              PASS. <span className="font-mono">message {messageId}</span>
            </p>
          </div>
        )}

        {error && <p className="mt-3 text-sm text-tertiary">{error}</p>}
      </StepCard>

      {/* ---- Custom MAIL FROM (per-domain deliverability) ---- */}
      {/* Only after provision() has created the domain's SES identity. Rendering it
          before the identity exists makes getMailFromStatus fail ("Email identity …
          does not exist"); the post-provision steps guarantee it's there. */}
      {ready && domain && ["verifying", "verified", "sending", "sent"].includes(step) && (
        <Card>
          <MailFromSetup domain={domain} region={preflight?.region} />
        </Card>
      )}

      {/* ---- Mailboxes (Cognito users in the deployed backend) ---- */}
      {ready && (
        <Card>
          <h2 className="text-lg font-semibold text-on-surface">Mailboxes</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            A mailbox is an email address someone can sign in to and use in the Inbox. You can add mailboxes once your
            email service is running.
          </p>

          {!canAddMailbox ? (
            // Locked upcoming step — no form to interact with yet, so it can't read
            // as a broken dead-end. Unlocks into the real form once the prerequisite
            // above is met. The message names the exact next action.
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-outline-variant/30 bg-surface-container-lowest/40 p-3 text-sm text-on-surface-variant">
              {step === "deploying" || step === "provisioning" || step === "verifying" ? (
                <Spinner className="mt-0.5 shrink-0" />
              ) : (
                <Lock className="mt-0.5 size-4 shrink-0 text-on-surface-variant/60" />
              )}
              <span>
                {step === "deploying" ? (
                  <>
                    Setting up your email service now — this usually takes <b className="text-on-surface">1–3 minutes</b>. Your
                    first mailbox unlocks here automatically when it&apos;s ready; you can keep this window open.
                  </>
                ) : step === "provisioning" ? (
                  <>Adding your domain&apos;s DNS records — just a moment…</>
                ) : step === "verifying" ? (
                  <>
                    Checking your domain is ready — usually <b className="text-on-surface">a few minutes</b>, occasionally up to
                    an hour while your DNS updates worldwide. MailPoppy checks automatically; you can leave this open and come
                    back.
                  </>
                ) : mbNoBackend ? (
                  <>
                    Your turn: set up your email service in the step above — that&apos;s where your mailboxes live. It runs for
                    about <b className="text-on-surface">1–3 minutes</b> with live progress shown right here, and this unlocks
                    the moment it finishes.
                  </>
                ) : (
                  <>
                    Finish setting up your domain&apos;s email above (the check takes a few minutes). A mailbox on a domain
                    that isn&apos;t ready yet can&apos;t send or receive mail.
                  </>
                )}
              </span>
            </div>
          ) : (
            <>
              {/* Friendly heads-up for an adopted/live domain: until a mailbox exists,
                  incoming mail to that address is turned away. Only while there's no
                  mailbox on this domain yet (the exact window the bounce can happen);
                  plain language, framed as "do it soon", never alarming. */}
              {domainMailboxes.length === 0 && (
                <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary-container/10 p-3.5 text-sm text-on-surface-variant">
                  <Mail className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span>
                    <b className="text-on-surface">Do people already send email to {domain}?</b> If an address
                    here already gets messages — like <span className="font-mono">hello@{domain}</span> — add a
                    mailbox for it soon. Until it has one, new messages to that address can&apos;t come in: the
                    person who wrote gets a note saying it couldn&apos;t be delivered. As soon as you add the
                    mailbox, email to it starts arriving normally.
                  </span>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
                  Email address
                  <span className="flex items-stretch">
                    <input
                      aria-label="Mailbox email"
                      name="new-mailbox-address"
                      value={mbLocalPart}
                      // Keep only the local part: if someone types a full address out
                      // of habit (the domain is already shown as the fixed suffix),
                      // drop everything from "@" on so we never build "you@d.com@d.com".
                      onChange={(e) => setMbLocalPart(e.target.value.trim().toLowerCase().replace(/@.*$/, ""))}
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
                    aria-label="Mailbox password"
                    type="password"
                    name="new-mailbox-password"
                    autoComplete="new-password"
                    value={mbPassword}
                    onChange={(e) => setMbPassword(e.target.value)}
                    className={cn(inputCls, "w-64")}
                  />
                </label>
                <Button onClick={() => void createMb()} disabled={mbBusy || !mbLocalPart || !mbPassword}>
                  {mbBusy ? <Spinner className="border-white/40 border-t-white" /> : null}
                  {mbBusy ? "Creating…" : "Create mailbox"}
                </Button>
              </div>
              <p className="mt-1.5 text-xs text-on-surface-variant/70">
                Password must meet the pool policy (min 8 chars, with upper &amp; lower case, a number and a symbol).
              </p>

              {mbCreated && (
                <div className="mt-4 rounded-xl border border-secondary/40 bg-secondary/10 p-5">
                  <h3 className="flex items-center gap-2 text-base font-semibold text-on-surface">
                    <Sparkles className="size-5 text-secondary" /> You&apos;re live — <C>{mbCreated}</C> is ready!
                  </h3>
                  <p className="mt-1.5 text-sm text-on-surface-variant">
                    Your email backend is running in your own AWS account and your first mailbox is set up. Nicely done.
                    Here&apos;s what to do next:
                  </p>
                  <ol className="mt-3 flex flex-col gap-2.5 text-sm text-on-surface-variant">
                    <li className="flex gap-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/20 font-mono text-[11px] font-semibold text-secondary">
                        1
                      </span>
                      <span>
                        Open the <b className="text-on-surface">Inbox</b> tab and sign in as <C>{mbCreated}</C>.
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/20 font-mono text-[11px] font-semibold text-secondary">
                        2
                      </span>
                      <span>
                        Send yourself a test email to confirm it works end-to-end. Heads-up: a brand-new domain can land in
                        spam for the first week or two while its sending reputation builds — that&apos;s normal and improves
                        on its own.
                      </span>
                    </li>
                    <li className="flex gap-2.5">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary/20 font-mono text-[11px] font-semibold text-secondary">
                        3
                      </span>
                      <span>
                        Read and reply on the go with the <b className="text-on-surface">MailPoppy mobile app</b>.
                      </span>
                    </li>
                  </ol>
                </div>
              )}
              {mbError && (
                <div className="mt-3 rounded-lg border border-tertiary/30 bg-tertiary-container/10 p-4 text-sm text-tertiary">{mbError}</div>
              )}
            </>
          )}

          {domainMailboxes.length > 0 && (
            <div className="mt-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <strong className="text-on-surface">
                  Mailboxes on {domain} ({domainMailboxes.length})
                </strong>
                {mbBackend && (
                  <details className="text-xs text-on-surface-variant/80">
                    <summary className="cursor-pointer select-none hover:text-on-surface-variant">Technical details</summary>
                    <div className="mt-1 whitespace-nowrap font-mono">
                      stack {stackName} · pool {mbBackend.userPoolId} · {mbBackend.region}
                    </div>
                  </details>
                )}
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {domainMailboxes.map((m) => (
                  <MailboxStorageRow
                    key={m.email}
                    email={m.email}
                    status={m.status}
                    stackName={stackName}
                    onDeleted={() => void loadMailboxes()}
                  />
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

          {/* Mail rules + retention are account-wide (one backend per install),
              so they live in the Account tab — not here, where the focus is
              first-domain onboarding. */}

          {/* Reassuring guidance, at the end so it never pushes the controls down.
              (The live AWS-permissions lights live permanently in the app sidebar.) */}
          <AdminPrivacyNotice />
      </div>
    </div>
  );
}
