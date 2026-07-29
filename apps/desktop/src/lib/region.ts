// Desktop client for the sidecar's active AWS region. The admin picks where their
// mail infrastructure (and all stored mail) lives — data-residency matters for
// some jurisdictions. The choice is persisted locally and re-applied to the
// sidecar on launch (the sidecar starts from its env default otherwise).
import { sidecar } from "./sidecar";

export interface RegionConfig {
  region: string;
  available: string[];
}

export function getRegion(): Promise<RegionConfig> {
  return sidecar("/config/region");
}

/** Fired on `window` after the active region changes, so open views (e.g. Home's domain list)
 *  re-query in the new region instead of showing stale results from the old one. */
export const REGION_CHANGED_EVENT = "mailpoppy:region-changed";

export async function setRegion(region: string): Promise<{ ok: true; region: string }> {
  const res = (await sidecar("/config/region", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ region }),
  })) as { ok: true; region: string };
  try {
    window.dispatchEvent(new CustomEvent(REGION_CHANGED_EVENT, { detail: res.region }));
  } catch {
    /* no DOM (e.g. unit tests) — callers still get the result */
  }
  return res;
}

const KEY = "mailpoppy.region";

export function savedRegion(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function persistRegion(region: string): void {
  try {
    localStorage.setItem(KEY, region);
  } catch {
    /* ignore */
  }
}

/**
 * Decide which region to restore to the sidecar at startup, or null to leave it
 * as-is. Prefers the connected deployment's region (the ground truth for what's
 * listable), else the admin's last explicit pick. Only returns a region that
 * differs from the current one AND is actually available — so we never POST a
 * no-op or an unsupported region. Pure + unit-tested.
 */
export function startupRegion(opts: {
  deploymentRegion?: string | null;
  saved?: string | null;
  current: string;
  available: string[];
}): string | null {
  const want = opts.deploymentRegion ?? opts.saved ?? null;
  if (!want || want === opts.current || !opts.available.includes(want)) return null;
  return want;
}

/**
 * Re-apply the persisted region to the sidecar on launch so the first listing
 * (Home) queries the right region. Without this the sidecar starts at its env /
 * account default, and a domain deployed to another region looks missing until the
 * admin detours through the region picker and back. Best-effort: any failure leaves
 * the sidecar at its default. Returns the region now in effect.
 */
export async function restoreStartupRegion(deploymentRegion?: string | null): Promise<string> {
  const cfg = await getRegion();
  const want = startupRegion({ deploymentRegion, saved: savedRegion(), current: cfg.region, available: cfg.available });
  if (!want) return cfg.region;
  const r = await setRegion(want);
  persistRegion(r.region);
  return r.region;
}
