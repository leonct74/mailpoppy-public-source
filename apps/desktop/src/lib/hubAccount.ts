// Link from the desktop to the MailPoppy website's activation funnel. No accounts, auth or billing
// happen in the desktop — those all live on the website. The desktop only builds a URL that opens
// the pricing/activation page for a domain, carrying the domain's PUBLIC backend config so the
// website can register + activate it once the admin signs in (or signs up) there.

// Where the Hub lives. Override for staging via localStorage["mailpoppy.hubUrl"].
const HUB_URL = (
  (typeof localStorage !== "undefined" && localStorage.getItem("mailpoppy.hubUrl")) ||
  "https://mailpoppy.com"
).replace(/\/$/, "");

export interface DeploymentForHub {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
}

/** The /activate page URL for a domain, with its public backend config encoded for the website. */
export function activationUrl(domain: string, deployment: DeploymentForHub): string {
  const dep = btoa(JSON.stringify(deployment)); // all-public values; base64 just keeps the URL tidy
  return `${HUB_URL}/activate?${new URLSearchParams({ domain, dep }).toString()}`;
}

/**
 * Are the MailPoppy native apps actually downloadable yet? Server-driven (env `MOBILE_APPS_LIVE` on
 * the Hub) so it flips for every installed desktop at once the day the apps ship — the desktop can't
 * push a release to every copy. Defaults to FALSE on any error: we'd rather show "coming soon" than
 * sell a download that doesn't exist.
 */
export async function mobileAppsLive(): Promise<boolean> {
  try {
    const res = await fetch(`${HUB_URL}/api/mobile-status`, { cache: "no-store" });
    if (!res.ok) return false;
    const j = (await res.json()) as { live?: boolean };
    return j.live === true;
  } catch {
    return false;
  }
}

/** Record "notify me when the mobile app is out" for a domain's admin. Best-effort; never throws. */
export async function notifyMobileInterest(email: string, domain: string): Promise<boolean> {
  try {
    const res = await fetch(`${HUB_URL}/api/mobile-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, domain }),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { ok?: boolean };
    return j.ok === true;
  } catch {
    return false;
  }
}

/** What the Hub currently knows about a domain, relative to the LIVE backend it should point at. */
export type HubDomainStatus =
  | "current" // registered, entitled, and its stored config MATCHES the live backend
  | "stale" // registered + entitled, but the stored config points at a DIFFERENT (old) backend
  | "inactive" // registered but no active plan (403) — can't read the config to compare
  | "unregistered" // the Hub has never heard of this domain (404)
  | "unknown"; // couldn't reach the Hub / parse — don't guess

const stripSlash = (s: string) => (s ?? "").replace(/\/+$/, "");

/**
 * Compare the Hub's stored backend config for a domain against the LIVE backend it should serve.
 * Catches the "torn down + redeployed → new Cognito pool/client/API, but the Hub still points at the
 * old one" case, which otherwise breaks mobile sign-in with a cryptic "user pool client … does not
 * exist" (resolve stays 200 for an entitled/comped domain, so it serves dead coordinates). The Hub's
 * resolve endpoint is public and returns ONLY these public ids, so no auth is needed to check.
 */
export async function checkHubDomain(domain: string, live: DeploymentForHub): Promise<HubDomainStatus> {
  try {
    const res = await fetch(`${HUB_URL}/api/resolve?domain=${encodeURIComponent(domain)}`);
    if (res.status === 404) return "unregistered";
    if (res.status === 403) return "inactive";
    if (!res.ok) return "unknown";
    const cfg = (await res.json()) as Partial<DeploymentForHub>;
    const same =
      (cfg.userPoolId ?? "") === live.userPoolId &&
      (cfg.clientId ?? "") === live.clientId &&
      (cfg.region ?? "") === live.region &&
      stripSlash(cfg.apiBaseUrl ?? "") === stripSlash(live.apiBaseUrl);
    return same ? "current" : "stale";
  } catch {
    return "unknown";
  }
}
