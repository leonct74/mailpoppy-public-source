// Buy a domain's mobile/web client access through AgentsPoppy's in-app checkout — MailPoppy's
// paywall runs through AgentsPoppy now (the first-party `domain-access` product, `target` = the
// domain), not MailPoppy's own Stripe. This replaces the old "open mailpoppy.com/activate" steering.
//
// Flow: POST agentspoppy.com/api/checkout → a hosted Stripe Checkout URL → open it in the OS browser
// (openExternal handles both the standalone Tauri window and the AgentsPoppy-container iframe). On
// completion AgentsPoppy writes the entitlement (target = domain) and pushes it to the Hub, which
// flips the domain on — so the desktop needs no callback; its Hub status poll reflects it.
import { openExternal } from "./openExternal";
import { sidecar } from "./sidecar";

// Where the AgentsPoppy commerce plane lives. Override for staging via localStorage.
const AGENTSPOPPY_BASE = (
  (typeof localStorage !== "undefined" && localStorage.getItem("mailpoppy.agentspoppyUrl")) ||
  "https://agentspoppy.com"
).replace(/\/$/, "");

// MailPoppy's poppy id + the product that unlocks a domain (must match what's priced in the
// AgentsPoppy admin dashboard).
const POPPY_ID = "com.mailpoppy.desktop";
const DOMAIN_ACCESS_PRODUCT = "domain-access";

// A stable, OPAQUE buyer id. It's unguessable, which matters: it's the capability that lets this
// buyer open their own billing portal (cancel / update card / invoices). (A guessable id like the
// domain would let anyone open — and cancel — someone else's subscription.) Entitlement is still
// checked by `target` = the domain, so this id never gates access; it only ties billing to this buyer.
//
// It's persisted by the sidecar in ~/.mailpoppy (`GET/POST /commerce/buyer-id`), NOT in webview
// localStorage: localStorage doesn't survive reinstalls and differs between the standalone webview and
// the AgentsPoppy container (different origins), so a buyer who paid in one context would hit
// "no billing account" in another. The sidecar store is one id per machine, shared by every context
// and surviving updates. We keep a localStorage copy purely as (a) a *seed* the sidecar adopts on
// first use — so anyone who already paid under an old localStorage id keeps their billing link — and
// (b) a last-resort fallback if the sidecar is briefly unreachable.
const BUYER_KEY = "mailpoppy.buyerId";

function localBuyerId(): string {
  let id = localStorage.getItem(BUYER_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(BUYER_KEY, id);
  }
  return id;
}

let cachedBuyerId: string | null = null;

async function buyerId(): Promise<string> {
  if (cachedBuyerId) return cachedBuyerId;
  const seed = localStorage.getItem(BUYER_KEY) ?? undefined;
  try {
    const { buyerId: id } = await sidecar<{ buyerId: string }>("/commerce/buyer-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed }),
    });
    cachedBuyerId = id;
    localStorage.setItem(BUYER_KEY, id); // mirror for the fallback path below
    return id;
  } catch {
    // Sidecar briefly unreachable — fall back to the local id so checkout/portal still function. It's
    // the same value the sidecar would have adopted as the seed, so they converge once it's reachable.
    return localBuyerId();
  }
}

export type CheckoutResult =
  | { ok: true; url: string; opened: boolean }
  | { ok: false; error: string };

/**
 * Start the AgentsPoppy checkout for a domain's access and open it in the browser. `buyerId` is keyed
 * to the domain (one buyer/entitlement per domain; the Hub gates on `target` = domain, not the buyer).
 * Returns the checkout URL + whether it was handed to the browser — so a caller can show a fallback
 * link if the OS hand-off failed (e.g. a stale Tauri build whose opener plugin isn't active yet).
 */
export async function startDomainCheckout(domain: string): Promise<CheckoutResult> {
  let url: string;
  try {
    const res = await fetch(`${AGENTSPOPPY_BASE}/api/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poppyId: POPPY_ID,
        productId: DOMAIN_ACCESS_PRODUCT,
        target: domain,
        buyerId: await buyerId(),
      }),
    });
    const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !j.url) return { ok: false, error: j.error || `checkout_failed_${res.status}` };
    url = j.url;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network_error" };
  }
  const opened = await openExternal(url);
  return { ok: true, url, opened };
}

/**
 * Open the buyer's billing portal (Stripe-hosted) so they can cancel the subscription, update their
 * card, or see invoices. Keyed by this install's opaque buyerId. Returns the portal URL + whether it
 * opened (so a caller can show a fallback link if the OS hand-off failed).
 */
export async function openBillingPortal(): Promise<CheckoutResult> {
  let url: string;
  try {
    const res = await fetch(`${AGENTSPOPPY_BASE}/api/billing-portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poppyId: POPPY_ID, buyerId: await buyerId() }),
    });
    const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !j.url) return { ok: false, error: j.error || `portal_failed_${res.status}` };
    url = j.url;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network_error" };
  }
  const opened = await openExternal(url);
  return { ok: true, url, opened };
}

/** Is this domain currently purchased in AgentsPoppy? (target-scoped, no buyer needed.) Best-effort:
 *  returns false on any error. Mostly the Hub's resolve gate is authoritative — this is for showing
 *  status in the desktop without waiting on the Hub mirror. */
/** A domain's standing in the AgentsPoppy commerce plane. `status` mirrors AgentsPoppy's
 *  EntitlementStatus ("active" | "trialing" | "past_due" | "canceled" | "none"); for a trialing
 *  subscription `currentPeriodEnd` is when the free trial runs out. */
export interface DomainStanding {
  entitled: boolean;
  status: string;
  kind: string | null;
  /** Epoch ms the current period (or trial) ends; null when unknown. */
  currentPeriodEnd: number | null;
}

const NOT_ENTITLED: DomainStanding = { entitled: false, status: "none", kind: null, currentPeriodEnd: null };

export async function getDomainStanding(domain: string): Promise<DomainStanding> {
  try {
    const res = await fetch(
      `${AGENTSPOPPY_BASE}/api/entitlement?poppyId=${encodeURIComponent(POPPY_ID)}` +
        `&productId=${encodeURIComponent(DOMAIN_ACCESS_PRODUCT)}&target=${encodeURIComponent(domain)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return NOT_ENTITLED;
    const j = (await res.json()) as Partial<DomainStanding>;
    return {
      entitled: j.entitled === true,
      status: typeof j.status === "string" ? j.status : "none",
      kind: typeof j.kind === "string" ? j.kind : null,
      // Older AgentsPoppy builds don't send this — absent just means "no countdown", never a lockout.
      currentPeriodEnd: typeof j.currentPeriodEnd === "number" ? j.currentPeriodEnd : null,
    };
  } catch {
    return NOT_ENTITLED;
  }
}

export async function isDomainPurchased(domain: string): Promise<boolean> {
  return (await getDomainStanding(domain)).entitled;
}

/**
 * How many free-trial days the `domain-access` product currently offers, straight from the
 * AgentsPoppy listing — so changing the trial in the AgentsPoppy admin changes what the app offers,
 * with no MailPoppy release. Returns null when there's no trial configured or the listing can't be
 * read, which simply falls back to the plain "Set up mobile access" wording.
 */
export async function getTrialDays(): Promise<number | null> {
  try {
    const res = await fetch(`${AGENTSPOPPY_BASE}/api/products/${encodeURIComponent(POPPY_ID)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      products?: { productId?: string; pricing?: { trialDays?: unknown } }[];
    };
    const product = j.products?.find((p) => p.productId === DOMAIN_ACCESS_PRODUCT);
    const days = product?.pricing?.trialDays;
    return typeof days === "number" && days > 0 ? Math.floor(days) : null;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

/**
 * Whole days left before `endMs`, rounded UP so the last partial day still reads "1 day left"
 * rather than "0". Returns null when there's no date to count from, and never goes below 0.
 * PURE — unit-tested; the panel just renders what this returns.
 */
export function daysLeft(endMs: number | null | undefined, nowMs: number): number | null {
  if (typeof endMs !== "number" || !Number.isFinite(endMs)) return null;
  return Math.max(0, Math.ceil((endMs - nowMs) / DAY_MS));
}

/** Human phrasing for a trial countdown: "1 day left" / "5 days left" / "ends today". */
export function trialCountdownLabel(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 0) return "ends today";
  return `${days} ${days === 1 ? "day" : "days"} left`;
}
