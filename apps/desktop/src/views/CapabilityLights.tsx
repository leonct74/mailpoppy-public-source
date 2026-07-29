import { useEffect, useRef, useState } from "react";
import { ShieldCheck, RefreshCw, Copy, Check } from "lucide-react";
import { getCapabilities, capabilityTiers, type Capabilities, type CapStatus } from "../lib/capabilities";
import { POLICY_DOCS, type PolicyTier } from "../lib/policies";
import { friendlyError } from "../lib/errors";
import { ExtLink, Spinner, cn } from "../ui";

// A persistent reassurance for the admin, pinned in the sidebar so it's visible on
// every screen: which AWS capability tiers the active identity actually has, as
// green / red / amber lights — so a security-conscious user who detaches the deploy
// policy can see, at a glance and at any moment, that their MailPoppy keys can no
// longer build or destroy infrastructure. Re-checks when the window regains focus,
// so flipping a policy in the AWS console reflects here as soon as they switch back.

const dotClass = (s: CapStatus) =>
  s === "allowed" ? "bg-secondary" : s === "denied" ? "bg-tertiary" : "bg-warn";
const dotLabel = (s: CapStatus) => (s === "allowed" ? "ok" : s === "denied" ? "missing" : "unknown");

/** Copies a policy's JSON to the clipboard so it can be pasted into the IAM
 *  console — available at any time, not just during first-run onboarding. */
function CopyPolicyButton({ tier }: { tier: PolicyTier }) {
  const [copied, setCopied] = useState(false);
  const { label, json } = POLICY_DOCS[tier];
  function copy() {
    navigator.clipboard?.writeText(json).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
    >
      {copied ? <Check className="size-3.5 shrink-0 text-secondary" /> : <Copy className="size-3.5 shrink-0" />}
      <span>{copied ? "Copied!" : `Copy ${label}`}</span>
    </button>
  );
}

export function CapabilityLights() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      setCaps(await getCapabilities());
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }
  useEffect(() => {
    void load();
    // Re-check when the user comes back from (e.g.) the AWS console, so a policy
    // they just attached or detached is reflected without a manual refresh.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <section
      aria-label="AWS permissions"
      className="rounded-lg border border-outline-variant/10 bg-surface-container-lowest/60 p-4"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-on-surface">
          <ShieldCheck className="size-3.5 text-primary" /> AWS permissions
        </h3>
        <button
          onClick={() => void load()}
          disabled={loading}
          aria-label="Re-check permissions"
          className="text-on-surface-variant/60 transition-colors hover:text-on-surface disabled:opacity-50"
        >
          {loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
        </button>
      </div>

      {error ? (
        <p className="text-xs text-tertiary">{error}</p>
      ) : !caps ? (
        <p className="text-xs text-on-surface-variant">Checking what this identity can do…</p>
      ) : !caps.connected ? (
        <p className="text-xs leading-snug text-on-surface-variant/80">
          Connect your AWS account to see which permissions are active.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {capabilityTiers(caps).map((t) => (
            <li key={t.key} className="flex items-start gap-2.5">
              <span
                className={cn("mt-1 size-2.5 shrink-0 rounded-full", dotClass(t.status))}
                role="img"
                aria-label={`${t.label}: ${dotLabel(t.status)}`}
                title={dotLabel(t.status)}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-on-surface">{t.label}</div>
                <div className="text-xs leading-snug text-on-surface-variant">
                  {t.detail}
                  {t.fixUrl && (
                    <>
                      {" "}
                      <ExtLink href={t.fixUrl} className="text-primary hover:underline">
                        {t.fixLabel}
                      </ExtLink>
                      .
                    </>
                  )}
                </div>
              </div>
            </li>
          ))}
          {!caps.checkable && (
            <li className="mt-0.5 rounded-md border border-warn/20 bg-warn/5 px-2 py-1.5 text-[11px] leading-snug text-on-surface-variant">
              Couldn&apos;t run a live check — add the read-only{" "}
              <code className="font-mono text-on-surface">iam:SimulatePrincipalPolicy</code> action to this identity to see
              real status.
            </li>
          )}
        </ul>
      )}

      {/* Always available — so the policies can be re-attached at any time, long
          after the onboarding screen (and its links) have scrolled out of reach. */}
      <div className="mt-3 flex flex-col gap-0.5 border-t border-outline-variant/10 pt-2.5">
        <p className="mb-1 text-[11px] leading-snug text-on-surface-variant/70">
          Need a policy again? Copy it, then paste into IAM → Policies → Create → JSON.
        </p>
        <CopyPolicyButton tier="provisioning" />
        <CopyPolicyButton tier="deploy" />
      </div>
    </section>
  );
}
