/**
 * Durable, per-machine AgentsPoppy buyer id.
 *
 * MailPoppy sells a domain's mobile/web access through AgentsPoppy's checkout, and the buyer's
 * Stripe *customer* is keyed by an opaque `buyerId` (see `apps/desktop/src/lib/commerce.ts`). That id
 * is the capability that later opens the buyer's billing portal (cancel / update card / invoices), so
 * it MUST be:
 *   • stable — the SAME id across app updates, reinstalls, and whether MailPoppy runs standalone or
 *     inside the AgentsPoppy container. Webview `localStorage` is none of those (a container iframe and
 *     the standalone webview are different origins; a reinstall can clear it) — so a buyer who paid in
 *     one context could get "no billing account" in another. Persisting here, next to the provisioning
 *     ledger in `~/.mailpoppy`, gives ONE id per machine that every context shares.
 *   • unguessable — it's a capability, so anyone who learned it could open (and cancel) that billing.
 *     A random UUID gives ~122 bits.
 *
 * The id never gates mailbox access (that's the Cognito plane) nor entitlement (the Hub gates on the
 * domain `target`); it only ties billing management to this machine.
 */
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

function storePath(): string {
  return process.env.MAILPOPPY_BUYER_ID ?? join(homedir(), ".mailpoppy", "buyer-id.json");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readStored(): Promise<string | null> {
  try {
    const raw = await fs.readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as { buyerId?: unknown };
    return typeof parsed.buyerId === "string" && UUID_RE.test(parsed.buyerId) ? parsed.buyerId : null;
  } catch {
    return null; // missing / corrupt store → treat as unset
  }
}

async function write(id: string): Promise<void> {
  const path = storePath();
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify({ buyerId: id }, null, 2), "utf8");
}

// Serialise concurrent first-calls (checkout + portal can fire near-simultaneously) so we never
// generate and persist two different ids in a race.
let inFlight: Promise<string> | null = null;

/**
 * Return this machine's stable buyer id, creating it on first use.
 *
 * `seed` lets a client hand up an id it minted earlier in webview `localStorage` (before this durable
 * store existed): if we have no persisted id yet and the seed is a well-formed UUID, we ADOPT it — so
 * a buyer who already paid under that id keeps their billing link after upgrading. A persisted id
 * always wins over a seed; a malformed/absent seed just falls through to a fresh UUID.
 */
export async function getOrCreateBuyerId(seed?: string): Promise<string> {
  const existing = await readStored();
  if (existing) return existing;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    // Re-read inside the critical section in case a concurrent call just wrote one.
    const again = await readStored();
    if (again) return again;
    const id = seed && UUID_RE.test(seed) ? seed : randomUUID();
    await write(id);
    return id;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
