// Desktop client for the sidecar's cross-region discovery. Everything MailPoppy
// deploys lives in the user's OWN AWS account (a CloudFormation stack + SES
// identities + Cognito), NOT in this app's local state. So after a reinstall or a
// cleared cache the data is all still there — we just have to find which region
// holds it. These helpers do that, and also surface SES domains the user created
// outside MailPoppy so their whole cloud is visible, not just what this app made.
import { sidecar } from "./sidecar";
import { setRegion, persistRegion } from "./region";

export interface SesDomain {
  name: string;
  /** SES reports this domain verified for sending (DKIM/identity confirmed). */
  verified: boolean;
  /** SES sending is enabled for the identity (not paused). */
  sendingEnabled: boolean;
}

export interface RegionScan {
  region: string;
  stackExists: boolean;
  stackStatus: string | null;
  domains: SesDomain[];
}

export interface DiscoverResult {
  currentRegion: string;
  /** The region whose backend stack exists, or null if none does. */
  stackRegion: string | null;
  /** When no stack exists, the single region that holds SES domains (if exactly one). */
  domainRegion: string | null;
  regions: RegionScan[];
}

/** Scan every SES-inbound region for the backend stack + SES domains. */
export function discoverRegions(): Promise<DiscoverResult> {
  return sidecar<DiscoverResult>("/aws/discover");
}

/** Every SES domain identity in the ACTIVE region — managed or pre-existing. */
export function listCloudDomains(): Promise<{ region: string; domains: SesDomain[] }> {
  return sidecar("/aws/ses-domains");
}

/**
 * Best-effort: if the active region holds neither the backend nor the user's
 * domains, snap the sidecar to the region that does (preferring the backend
 * stack, else the sole region with SES domains) and persist it. This is what lets
 * a reinstalled / cache-cleared app re-find the user's existing setup without them
 * having to remember which region they deployed to. Returns the region switched to,
 * or null if nothing better was found (or discovery failed — never throws).
 *
 * Callers should only invoke this when there's no local region preference yet
 * (no saved deployment config / region), so an explicit user choice is respected.
 */
export async function autoDiscoverRegion(): Promise<string | null> {
  try {
    const d = await discoverRegions();
    const target = d.stackRegion ?? d.domainRegion;
    if (!target || target === d.currentRegion) return null;
    await setRegion(target); // also fires REGION_CHANGED_EVENT so open views re-list
    persistRegion(target);
    return target;
  } catch {
    return null; // offline / no creds yet — leave the sidecar where it is
  }
}
