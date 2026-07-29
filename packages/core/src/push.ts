// Mobile push-notification helpers, shared by the access API (token register /
// unregister) and the inbound-processor (fan-out a "new mail" push). Delivery is
// via the Expo Push Service: the mobile app obtains an ExponentPushToken and the
// backend POSTs messages to https://exp.host/--/api/v2/push/send. Everything here
// is pure (no I/O) so it can be unit-tested and reused on both Lambdas.

/** A single registered device for a mailbox. */
export interface DeviceToken {
  /** Expo push token, e.g. "ExponentPushToken[xxxxxxxx]". */
  token: string;
  platform: "ios" | "android";
  /** ISO-8601 timestamp of the last register/refresh — used for pruning. */
  updatedAt: string;
}

/** The per-mailbox set of device tokens, stored as one JSON doc in SETTINGS. */
export interface DeviceRegistry {
  tokens: DeviceToken[];
}

/** SETTINGS-table partition key holding a mailbox's registered device tokens. */
export function devicesSettingsKey(address: string): string {
  return `devices#${address.trim().toLowerCase()}`;
}

// Expo issues tokens shaped `ExponentPushToken[...]` (current) or the older
// `ExpoPushToken[...]`. Validate the envelope so we never store junk and never
// POST a malformed token to Expo.
const EXPO_TOKEN_RE = /^Expo(nent)?PushToken\[[^\][\s]+\]$/;

/** True for a well-formed Expo push token. */
export function isExpoPushToken(token: unknown): token is string {
  return typeof token === "string" && EXPO_TOKEN_RE.test(token.trim());
}

/** Keep at most this many devices per mailbox (most-recently-seen win). */
export const MAX_DEVICE_TOKENS = 20;
/** Drop tokens not refreshed within this many days (stale installs). */
export const DEVICE_TOKEN_TTL_DAYS = 90;
const DAY_MS = 86_400_000;

function normalizeRegistry(registry: DeviceRegistry | null | undefined): DeviceToken[] {
  if (!registry || !Array.isArray(registry.tokens)) return [];
  return registry.tokens.filter((t): t is DeviceToken => isExpoPushToken(t?.token));
}

/**
 * Prune a registry: drop tokens older than the TTL, then keep only the most
 * recently-updated `MAX_DEVICE_TOKENS`. Pure — returns a fresh registry.
 */
export function pruneDeviceTokens(
  registry: DeviceRegistry | null | undefined,
  now: number = Date.now(),
): DeviceRegistry {
  const cutoff = now - DEVICE_TOKEN_TTL_DAYS * DAY_MS;
  const tokens = normalizeRegistry(registry)
    .filter((t) => {
      const at = Date.parse(t.updatedAt);
      return Number.isNaN(at) ? true : at >= cutoff; // keep undated rather than drop
    })
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .slice(0, MAX_DEVICE_TOKENS);
  return { tokens };
}

/**
 * Register or refresh a device token. Re-registering an existing token updates
 * its platform + timestamp (and moves it to the front). Invalid tokens are
 * ignored (returns the registry pruned but otherwise unchanged).
 */
export function addDeviceToken(
  registry: DeviceRegistry | null | undefined,
  token: string,
  platform: DeviceToken["platform"],
  now: number = Date.now(),
): DeviceRegistry {
  if (!isExpoPushToken(token)) return pruneDeviceTokens(registry, now);
  const trimmed = token.trim();
  const existing = normalizeRegistry(registry).filter((t) => t.token !== trimmed);
  const next: DeviceRegistry = {
    tokens: [{ token: trimmed, platform, updatedAt: new Date(now).toISOString() }, ...existing],
  };
  return pruneDeviceTokens(next, now);
}

/** Unregister a token (e.g. on sign-out / DeviceNotRegistered). Pure. */
export function removeDeviceToken(
  registry: DeviceRegistry | null | undefined,
  token: string,
): DeviceRegistry {
  const trimmed = String(token).trim();
  return { tokens: normalizeRegistry(registry).filter((t) => t.token !== trimmed) };
}

/** Remove a batch of tokens at once (e.g. all Expo flagged DeviceNotRegistered). */
export function removeDeviceTokens(
  registry: DeviceRegistry | null | undefined,
  tokens: Iterable<string>,
): DeviceRegistry {
  const drop = new Set([...tokens].map((t) => String(t).trim()));
  return { tokens: normalizeRegistry(registry).filter((t) => !drop.has(t.token)) };
}

// ---- Expo push message shape -----------------------------------------------

/** One message in an Expo push batch (subset of fields we use). */
export interface ExpoPushMessage {
  to: string;
  title?: string;
  body?: string;
  sound?: "default" | null;
  data?: Record<string, unknown>;
  badge?: number;
  /** Delivery priority. "high" wakes Android apps that the OS has frozen or
   *  put in Doze (Samsung and friends freeze backgrounded apps within minutes);
   *  without it, new-mail pushes are deferred until the user reopens the app. */
  priority?: "default" | "normal" | "high";
  /** Android channel id (created on the device). */
  channelId?: string;
  /** Notification category — must match a category the app registered with the
   *  OS; its actions (e.g. "Mark as read") then show on the notification. */
  categoryId?: string;
}

export interface BuildPushOptions {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  badge?: number;
  channelId?: string;
  categoryId?: string;
}

// Keep payloads small — Expo/APNs limit the total notification size. Trim the
// human-facing fields defensively (the caller passes sender + subject).
const MAX_TITLE = 100;
const MAX_BODY = 240;
function clamp(s: string | undefined, max: number): string | undefined {
  if (s == null) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Build one Expo push message per token. Invalid tokens are skipped, so the
 * result only ever targets well-formed Expo tokens.
 */
export function buildExpoPushMessages(
  tokens: Array<string | DeviceToken>,
  opts: BuildPushOptions,
): ExpoPushMessage[] {
  const title = clamp(opts.title, MAX_TITLE);
  const body = clamp(opts.body, MAX_BODY);
  const seen = new Set<string>();
  const out: ExpoPushMessage[] = [];
  for (const entry of tokens) {
    const token = (typeof entry === "string" ? entry : entry?.token)?.trim();
    if (!isExpoPushToken(token) || seen.has(token)) continue;
    seen.add(token);
    out.push({
      to: token,
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      sound: "default",
      // New mail is time-sensitive: high priority is what lets FCM wake a
      // frozen/dozing Android app so the notification shows immediately.
      priority: "high",
      ...(opts.data ? { data: opts.data } : {}),
      ...(typeof opts.badge === "number" ? { badge: opts.badge } : {}),
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
    });
  }
  return out;
}
