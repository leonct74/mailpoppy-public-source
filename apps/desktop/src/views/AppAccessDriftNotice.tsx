import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { Card, Button } from "../ui";
import { openExternal } from "../lib/openExternal";
import { listProvisionedDomains } from "../lib/teardown";
import { activationUrl, checkHubDomain, type DeploymentForHub, type HubDomainStatus } from "../lib/hubAccount";

/**
 * After a backend (re)deploy, reconcile EVERY managed domain's mobile & web app
 * registration against the freshly-deployed backend and warn about any that drifted.
 *
 * A rebuild mints a new Cognito pool / API, so a domain that was active in the apps now
 * silently points at the old, dead coordinates (`stale`) — or was never activated
 * (`unregistered`) — until the admin re-activates it. Surfacing this *at deploy time*
 * (paired with the always-on Home banner) is the "reconcile at the moment drift is
 * introduced" guard: a redeploy/reinstall can never quietly cut a domain off from the
 * apps. Data + check are injected so this is unit-tested without live AWS/Hub.
 */
export function AppAccessDriftNotice({
  deployment,
  stackName,
  listDomains = (s: string) => listProvisionedDomains(s).then((r) => r.domains),
  check = checkHubDomain,
  open = openExternal,
}: {
  /** The just-deployed backend every managed domain SHOULD now resolve to. */
  deployment: DeploymentForHub;
  stackName: string;
  listDomains?: (stackName: string) => Promise<string[]>;
  check?: (domain: string, live: DeploymentForHub) => Promise<HubDomainStatus>;
  /** Opens the pre-filled Hub activation page (injected for tests). */
  open?: (url: string) => Promise<boolean> | void;
}) {
  const [drifted, setDrifted] = useState<string[]>([]);

  // Read the callbacks via refs so the effect does NOT depend on their identity —
  // callers routinely pass fresh closures each render (and `deployment` as an inline
  // object literal). Depend only on the PRIMITIVE deployment fields + stackName, so the
  // reconcile runs when the backend actually changes, not on every render (which would
  // be an infinite fetch/setState loop).
  const listRef = useRef(listDomains);
  listRef.current = listDomains;
  const checkRef = useRef(check);
  checkRef.current = check;
  const { apiBaseUrl, userPoolId, clientId, region } = deployment;

  useEffect(() => {
    let alive = true;
    (async () => {
      const dep: DeploymentForHub = { apiBaseUrl, userPoolId, clientId, region };
      const domains = await listRef.current(stackName).catch(() => []);
      const results = await Promise.all(
        domains.map(async (d) => ({
          d,
          s: await checkRef.current(d, dep).catch(() => "unknown" as HubDomainStatus),
        })),
      );
      if (!alive) return;
      // Only confirmed problems — never "unknown" (a guess) or "current".
      setDrifted(
        results.filter((r) => r.s === "stale" || r.s === "unregistered" || r.s === "inactive").map((r) => r.d),
      );
    })();
    return () => {
      alive = false;
    };
  }, [apiBaseUrl, userPoolId, clientId, region, stackName]);

  if (drifted.length === 0) return null;
  const one = drifted.length === 1;
  return (
    <Card className="border-warn/40 bg-warn/10">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-on-surface">
            Re-activate {one ? "this domain" : "these domains"} for the mobile &amp; web apps
          </p>
          <p className="mt-1 leading-relaxed text-on-surface-variant">
            Rebuilding the backend changed its identifiers, so {one ? "this domain" : "these domains"} now point at the
            old backend in the apps — their mail won&apos;t appear there until you re-activate. One click per domain
            opens its pre-filled activation page:
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {drifted.map((d) => (
              <div key={d} className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-highest/40 px-3 py-2">
                <span className="truncate font-mono text-on-surface">{d}</span>
                <Button variant="secondary" onClick={() => void open(activationUrl(d, deployment))}>
                  <ExternalLink className="size-4" /> Re-activate
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
