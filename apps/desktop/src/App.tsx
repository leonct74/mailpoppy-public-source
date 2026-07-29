import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutDashboard, Inbox, ArrowLeftRight, HeartPulse, SlidersHorizontal, ShieldCheck, type LucideIcon } from "lucide-react";
import { HomeView } from "./views/HomeView";
import { DomainView } from "./views/DomainView";
import { SetupWizard } from "./views/SetupWizard";
import { InboxView } from "./views/InboxView";
import { AccountView } from "./views/AccountView";
import { BackendUpdateBanner } from "./views/BackendUpdateBanner";
import { SendingHealthView } from "./views/SendingHealthView";
import { MigrationView } from "./views/MigrationView";
import { ConnectView } from "./views/ConnectView";
import { LoginView } from "./views/LoginView";
import { MailpoppyClient } from "@mailpoppy/api-client";
import { CognitoAuth } from "./lib/auth";
import { listMailboxes } from "./lib/mailbox";
import { makeMailClient } from "./lib/mailClient";
import { establishMailboxKeysForLogin, clearMailboxKeySession, setActiveMailboxKey, forgetMailboxKey } from "./lib/mailboxKeys";
import { clearMailCaches } from "./lib/mailCache";
import {
  loadAccounts,
  saveAccounts,
  withMailbox,
  withoutMailbox,
  withActive,
  type AccountsState,
} from "./lib/accounts";
import { cn, Logo, Spinner } from "./ui";
import { onHostEvent } from "./lib/hostBridge";
import { restoreStartupRegion, savedRegion } from "./lib/region";
import { autoDiscoverRegion } from "./lib/discovery";
import {
  loadDeploymentConfig,
  saveDeploymentConfig,
  clearDeploymentConfig,
  DEFAULT_STACK_NAME,
  type DeploymentConfig,
} from "./lib/deploymentConfig";

// "Setup" is intentionally NOT a sidebar tab — it's a per-domain flow reached
// from "Add domain" (Home) or a domain card's "Domain setup" action, so it's
// never ambiguous which domain you're configuring.
type Tab = "home" | "inbox" | "migrate" | "health" | "account";

const NAV: { id: Tab; label: string; icon: LucideIcon; blurb: string }[] = [
  { id: "home", label: "Home", icon: LayoutDashboard, blurb: "Overview of your domains and mailboxes" },
  { id: "inbox", label: "Inbox", icon: Inbox, blurb: "Read and send mail" },
  { id: "migrate", label: "Migrate", icon: ArrowLeftRight, blurb: "Bring your old mail across via IMAP" },
  { id: "health", label: "Sending health", icon: HeartPulse, blurb: "Is each domain's mail reaching inboxes?" },
  { id: "account", label: "Account", icon: SlidersHorizontal, blurb: "Shared settings & the AWS resources MailPoppy manages" },
];

/** Setup drill-in target: a new domain ({}) or re-running an existing one. */
type SetupTarget = { domain?: string };

const CREDENTIALS_TOOLTIP =
  "MailPoppy reads your AWS credentials from your machine's own configuration (~/.aws profile, SSO, or environment) using AWS's official SDK — the same way the AWS CLI does — and uses them only on this computer. They are never copied, uploaded, or stored: not on MailPoppy's servers, not in any cloud.";

/**
 * Mailbox tab state machine:
 *   no config            → demo inbox (offline) + "Connect a deployment"
 *   config, signed out   → login
 *   config, signed in    → live inbox (Cognito JWT → API Gateway)
 */
function InboxTab({ prefillEmail, regionReady }: { prefillEmail?: string | null; regionReady?: boolean }) {
  const [config, setConfig] = useState<DeploymentConfig | null>(() => loadDeploymentConfig());
  const [editingConfig, setEditingConfig] = useState(false);
  // Every mailbox added to this install (all in the one deployed pool) + which one
  // is active. Cognito keeps each mailbox's tokens per username, so sessions
  // coexist and switching never re-asks for a password.
  const [accounts, setAccounts] = useState<AccountsState>(() => loadAccounts());
  // True while the user is signing IN AN ADDITIONAL mailbox (keeps the current one).
  const [adding, setAdding] = useState(false);
  const activeEmail = accounts.activeEmail;
  // Fresh install, backend already deployed (reinstall / new machine / the packaged
  // container): there's no saved config, but the sidecar can read every value the
  // Inbox needs straight from the stack outputs — so resolve them instead of making
  // the admin paste them into ConnectView. The manual form stays as the fallback for
  // when no backend is found (true first run, or no AWS credentials on this machine).
  const [probing, setProbing] = useState(() => loadDeploymentConfig() === null);
  // One shot per mount: after an explicit Disconnect (config → null again) the
  // user chose to leave — silently re-resolving would make Disconnect a no-op.
  const probedRef = useRef(false);
  useEffect(() => {
    if (config !== null) {
      setProbing(false);
      return;
    }
    if (regionReady === false) return; // wait for the startup region restore/discovery
    if (probedRef.current) return;
    probedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await listMailboxes(DEFAULT_STACK_NAME);
        if (cancelled) return;
        if (res.apiBaseUrl && res.userPoolId && res.clientId) {
          const c: DeploymentConfig = {
            apiBaseUrl: res.apiBaseUrl,
            userPoolId: res.userPoolId,
            clientId: res.clientId,
            region: res.region,
            stackName: DEFAULT_STACK_NAME,
          };
          saveDeploymentConfig(c);
          setConfig(c);
        }
      } catch {
        /* no deployed backend (or no creds) — fall through to demo + Connect */
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, regionReady]);

  const auth = useMemo(() => (config ? new CognitoAuth(config) : null), [config]);
  const liveClient = useMemo(
    () => (config && auth ? makeMailClient({ apiBaseUrl: config.apiBaseUrl, getToken: () => auth.getToken() }) : null),
    [config, auth],
  );
  // A direct client for the mailbox-key endpoints (GET/PUT /mailbox-keys), used by
  // the login flow to generate/unwrap the encryption keypair. Same Cognito JWT as
  // the mail path — no AWS credentials.
  const keyStore = useMemo(
    () => (config && auth ? new MailpoppyClient({ apiBaseUrl: config.apiBaseUrl, getToken: () => auth.getToken() }) : null),
    [config, auth],
  );

  function updateAccounts(next: AccountsState) {
    saveAccounts(next);
    setAccounts(next);
  }

  // Point auth + the encryption read-path at the active mailbox whenever it
  // changes; and MIGRATE a legacy single-session install (pre-switcher) into the
  // accounts list, so nobody is signed out by the upgrade.
  useEffect(() => {
    if (!auth) return;
    const active = accounts.accounts.find((a) => a.email === activeEmail);
    if (active) {
      auth.setActiveUsername(active.username);
      setActiveMailboxKey(active.email);
      return;
    }
    if (accounts.accounts.length === 0 && auth.hasSession()) {
      const username = auth.lastAuthUsername();
      void auth.currentEmail().then((email) => {
        if (email && username) updateAccounts(withMailbox(loadAccounts(), { email, username }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, activeEmail]);

  // "Open inbox" deep-link: if that mailbox is already added, just switch to it.
  useEffect(() => {
    if (!prefillEmail) return;
    const email = prefillEmail.trim().toLowerCase();
    setAccounts((cur) => {
      if (!cur.accounts.some((a) => a.email === email) || cur.activeEmail === email) return cur;
      const next = withActive(cur, email);
      saveAccounts(next);
      return next;
    });
  }, [prefillEmail]);

  // After a successful sign-in (first mailbox OR an added one): record it in the
  // list and make it active. The email comes from the fresh ID token, so it's the
  // real address even when the pool uses email as an alias.
  async function recordSignIn() {
    if (!auth) return;
    const username = auth.lastAuthUsername();
    const email = await auth.currentEmail();
    if (username && email) updateAccounts(withMailbox(loadAccounts(), { email, username }));
    setAdding(false);
  }

  function switchTo(email: string) {
    if (!accounts.accounts.some((a) => a.email === email)) return;
    updateAccounts(withActive(accounts, email)); // the effect above re-points auth + keys
  }

  function removeMailbox(email: string) {
    const acct = accounts.accounts.find((a) => a.email === email);
    if (!acct || !auth) return;
    auth.signOutUser(acct.username); // drop just this mailbox's tokens
    forgetMailboxKey(email);
    updateAccounts(withoutMailbox(accounts, email));
  }

  function signOutAll() {
    for (const a of accounts.accounts) auth?.signOutUser(a.username);
    auth?.signOut();
    clearMailboxKeySession();
    clearMailCaches();
    updateAccounts({ accounts: [], activeEmail: null });
    setAdding(false);
  }

  if (editingConfig) {
    return (
      <ConnectView
        initial={config}
        onSave={(c) => {
          saveDeploymentConfig(c);
          setConfig(c);
          // A different deployment = a different user pool: the stored sessions
          // and keys no longer apply.
          clearMailboxKeySession();
          clearMailCaches();
          updateAccounts({ accounts: [], activeEmail: null });
          setEditingConfig(false);
        }}
        onCancel={() => setEditingConfig(false)}
      />
    );
  }

  if (!config) {
    if (probing) {
      return (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-on-surface-variant">
          <Spinner /> Looking for your deployed backend…
        </div>
      );
    }
    return <InboxView demo onConnect={() => setEditingConfig(true)} />;
  }

  if (auth && (adding || !activeEmail)) {
    return (
      <div className="flex flex-col gap-3">
        {adding && (
          <button
            className="self-start text-sm text-primary underline-offset-2 hover:underline"
            onClick={() => setAdding(false)}
          >
            ← Back to inbox
          </button>
        )}
        <LoginView
          auth={auth}
          prefillEmail={adding ? undefined : (prefillEmail ?? undefined)}
          onSignedIn={() => void recordSignIn()}
          onReconfigure={() => setEditingConfig(true)}
          onEstablishKeys={keyStore ? (pw, email) => establishMailboxKeysForLogin(keyStore, pw, email) : undefined}
        />
      </div>
    );
  }

  const linkBtn = "text-primary underline-offset-2 hover:underline";

  return (
    <>
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-secondary/30 bg-secondary/10 px-4 py-2.5 text-sm text-on-surface-variant">
        <span className="text-secondary">
          ✅ Connected to <code className="font-mono text-xs">{config.apiBaseUrl}</code>
        </span>
        <button className={linkBtn} onClick={signOutAll}>
          Sign out{accounts.accounts.length > 1 ? " of all mailboxes" : ""}
        </button>
        <button className={linkBtn} onClick={() => setEditingConfig(true)}>Change deployment</button>
        <button
          className={linkBtn}
          onClick={() => {
            clearDeploymentConfig();
            clearMailboxKeySession();
            clearMailCaches();
            updateAccounts({ accounts: [], activeEmail: null });
            setConfig(null);
          }}
        >
          Disconnect
        </button>
      </div>
      {liveClient && (
        <InboxView
          key={activeEmail ?? "inbox"}
          client={liveClient}
          mailboxEmail={activeEmail}
          accounts={accounts.accounts.map((a) => a.email)}
          onSwitchMailbox={switchTo}
          onAddMailbox={() => setAdding(true)}
          onRemoveMailbox={removeMailbox}
        />
      )}
    </>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  // Tabs visited so far. Once visited, a view is kept mounted (hidden when
  // inactive) so its form data, scroll position and loaded data survive tab
  // switches — its effects still run just once, on first visit.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>(["home"]));
  // When set, the Home tab shows the per-domain workspace (drill-in) for this
  // domain instead of the overview. Clicking the Home nav (or the in-view back
  // button) clears it to return to the overview.
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  // When set, the Home tab shows the Setup wizard (add a new domain, or re-run
  // setup for an existing one) instead of the overview / domain workspace.
  const [setupTarget, setSetupTarget] = useState<SetupTarget | null>(null);
  // Cross-tab hand-offs from the domain workspace: which domain the Migrate tab
  // should default its destination to, and which mailbox the Inbox login should
  // be pre-filled for.
  const [migrateDomain, setMigrateDomain] = useState<string | null>(null);
  const [inboxEmail, setInboxEmail] = useState<string | null>(null);
  // Re-apply the persisted region to the sidecar before Home does its first listing.
  // The sidecar boots at its env/account-default region, so without this a domain
  // deployed elsewhere looks missing until you detour through the region picker. Gate
  // the Home overview on it so the first load already queries the right region.
  const [regionReady, setRegionReady] = useState(false);
  // Bumped to remount the whole content subtree so every view re-fetches. Used when the
  // AgentsPoppy host tells us our backend changed under us (see the host-event effect).
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cfgRegion = loadDeploymentConfig()?.region ?? null;
      await restoreStartupRegion(cfgRegion).catch(() => undefined);
      // No local hint at all (fresh install OR reinstall with wiped state): probe
      // the user's AWS for an existing backend / domains and snap to that region,
      // so a reinstall re-finds everything instead of booting into an empty default
      // region. Skipped when the user already has a deployment or an explicit pick,
      // so we never override a deliberate choice.
      if (!cfgRegion && !savedRegion()) {
        await autoDiscoverRegion().catch(() => undefined);
      }
      if (!cancelled) setRegionReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // When the operator tears our backend down from the AgentsPoppy console, this frame
  // stays alive but every view's loaded data (domains, resources, mailboxes) is now
  // stale. The host pushes `connection-changed`; drop any domain/setup drill-in (its
  // target may no longer exist) back to the overview and remount the content subtree so
  // each view re-fetches — no manual "Refresh" needed.
  useEffect(() => {
    return onHostEvent((e) => {
      if (e.hostEvent !== "connection-changed") return;
      // A teardown deletes the whole backend our local session points at (the Cognito
      // pool, API and stack). Clear the now-invalid local footprint FIRST so the
      // remounted Inbox doesn't read a stale deployment config and render a phantom
      // "Connected" state (login/list would then fail against the deleted pool); with
      // storage cleared it re-probes and honestly falls to demo + Connect, matching Home.
      if (e.reason === "teardown") {
        clearDeploymentConfig();
        clearMailboxKeySession();
        clearMailCaches();
        saveAccounts({ accounts: [], activeEmail: null });
      }
      setSelectedDomain(null);
      setSetupTarget(null);
      setReloadNonce((n) => n + 1);
    });
  }, []);
  function go(id: Tab) {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-base text-on-surface">
      {/* Top navigation — horizontal tabs, so the full window width below is content */}
      <header className="flex shrink-0 flex-col border-b border-outline-variant/10 bg-surface-container-low">
        {/* Row 1 — logo + meta, on their own line so the tabs below get full width */}
        <div className="flex items-center gap-4 px-6 pt-3 pb-1.5">
          <Logo />
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span
              className="hidden items-center gap-1.5 text-xs text-on-surface-variant md:flex"
              title={CREDENTIALS_TOOLTIP}
            >
              <ShieldCheck className="size-4 shrink-0 text-secondary" /> Credentials stay on this computer
            </span>
            <span className="rounded-full bg-primary-container/15 px-2 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-primary">
              Admin
            </span>
          </div>
        </div>
        {/* Row 2 — navigation tabs, spanning the full width */}
        <nav className="flex items-center gap-1 overflow-x-auto px-4 pb-2">
          {NAV.map(({ id, label, icon: Icon, blurb }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => {
                  // The Home nav always lands on the overview, even if a domain
                  // drill-in or the setup wizard is currently open.
                  if (id === "home") {
                    setSelectedDomain(null);
                    setSetupTarget(null);
                  }
                  go(id);
                }}
                aria-current={active ? "page" : undefined}
                title={blurb}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-primary-container/10 font-semibold text-primary"
                    : "font-medium text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>
      </header>
      {/* App-wide backend-update notice: an un-applied backend update can matter to the
          health of the user's own infrastructure, so it's announced here — not only in a
          panel at the bottom of Account. Hidden on the Account tab itself (the panel there
          is the review surface) and mutable per-update. */}
      <BackendUpdateBanner hidden={tab === "account"} onReview={() => go("account")} />
      <main key={reloadNonce} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Views stay mounted after first visit (only the active one is shown)
              so form data + scroll position survive tab switches. A bump to
              `reloadNonce` (host teardown) remounts this subtree so every view refetches. */}
          {visited.has("inbox") && (
            // The mailbox is a full-bleed three-pane layout that fills the
            // viewport (its panes scroll internally — this container does not).
            <div className={cn("min-h-0 flex-1 flex-col px-6 py-6", tab === "inbox" ? "flex" : "hidden")}>
              <InboxTab prefillEmail={inboxEmail} regionReady={regionReady} />
            </div>
          )}
          {/* The page content is the only scroll region for these views. */}
          {visited.has("home") && (
            <div className={cn("h-full overflow-y-auto px-8 py-8", tab === "home" ? "block" : "hidden")}>
              <div className="mx-auto max-w-6xl">
                {setupTarget ? (
                  <SetupWizard presetDomain={setupTarget.domain} onExit={() => setSetupTarget(null)} />
                ) : selectedDomain ? (
                  <DomainView
                    domain={selectedDomain}
                    onBack={() => setSelectedDomain(null)}
                    onRunSetup={() => setSetupTarget({ domain: selectedDomain })}
                    onOpenInbox={(email) => {
                      setInboxEmail(email);
                      go("inbox");
                    }}
                    onMigrateInto={(d) => {
                      setMigrateDomain(d);
                      go("migrate");
                    }}
                  />
                ) : !regionReady ? (
                  <div className="flex items-center gap-2 text-sm text-on-surface-variant">
                    <Spinner /> Loading…
                  </div>
                ) : (
                  <HomeView
                    onGoToSetup={() => setSetupTarget({})}
                    onOpenDomain={(d) => setSelectedDomain(d)}
                    onSetupDomain={(d) => setSetupTarget({ domain: d })}
                  />
                )}
              </div>
            </div>
          )}
          {visited.has("migrate") && (
            <div className={cn("h-full overflow-y-auto px-8 py-8", tab === "migrate" ? "block" : "hidden")}>
              <div className="mx-auto max-w-6xl">
                <MigrationView preselectDomain={migrateDomain ?? undefined} />
              </div>
            </div>
          )}
          {visited.has("health") && (
            <div className={cn("h-full overflow-y-auto px-8 py-8", tab === "health" ? "block" : "hidden")}>
              <div className="mx-auto max-w-6xl">
                <SendingHealthView />
              </div>
            </div>
          )}
          {visited.has("account") && (
            <div className={cn("h-full overflow-y-auto px-8 py-8", tab === "account" ? "block" : "hidden")}>
              <div className="mx-auto max-w-6xl">
                <AccountView />
              </div>
            </div>
          )}
        </main>
    </div>
  );
}
