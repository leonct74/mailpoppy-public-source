// WHERE MailPoppy's local files live — the one module allowed to answer that question.
//
// Two files persist on this machine and both matter more than they look:
//  - `provisioning-ledger.json` (ledger.ts): not just the transparency display — teardown
//    REPLAYS it (provisioning.ts::discoverProvisionedDomains → teardownAll) to decide
//    which SES identities and DNS records to delete at uninstall. Lose it silently and
//    live mail infrastructure is stranded in the user's AWS account.
//  - `buyer-id.json` (buyerId.ts): the capability that opens the buyer's Stripe billing
//    portal. Lose it and a paying customer re-mints a new id ("no billing account").
//
// Since 0.1.16 both live in the data folder the AgentsPoppy host hands this backend in
// its bootstrap (`dataDir`, normally ~/.agentspoppy/extension-data/com.mailpoppy.desktop),
// not in ~/.mailpoppy. The backend is being CONFINED (0.1.17 will declare
// `backend.isolation: "strict"`): Node's permission model then lets it read only its
// install folder and write only `dataDir` + the OS temp dir — the home directory,
// ~/.aws included, is off-limits BY THE RUNTIME.
//
//  - `initStorage(dataDir)` must run once at boot, before any route. It also performs a
//    ONE-TIME, idempotent, per-file copy of a pre-0.1.16 ~/.mailpoppy into the data
//    folder. That copy can only succeed while the backend is still unconfined — which is
//    why 0.1.16 ships WITHOUT the isolation flag and 0.1.17 flips it (the VM-Poppy
//    0.1.11 → 0.1.12 / VPN-Poppy 0.1.8 → 0.1.9 pattern). The old folder is never deleted.
//  - Standalone (no AGENTSPOPPY_BOOTSTRAP, e.g. the dev shell): no dataDir → the legacy
//    ~/.mailpoppy keeps being used, unchanged. Standalone is never confined.
//
//  🪤 Under `--permission`, `fs.existsSync` on a DENIED path THROWS ERR_ACCESS_DENIED
//    instead of returning false (measured, 2026-08-16). Every existence probe here goes
//    through `exists()` — a denied probe must read as "not there", never as a 500.

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The pre-0.1.16 location. Read (once, for migration) — never written again. */
export const LEGACY_HOME = join(homedir(), ".mailpoppy");

/** The two files that make up MailPoppy's local state. */
const STATE_FILES = ["provisioning-ledger.json", "buyer-id.json"] as const;

let home: string | null = null;

/**
 * Point storage at the host's data folder. Falls back to the legacy folder when the host
 * sent no dataDir (standalone, or an AgentsPoppy older than 0.3.x — both unconfined, so
 * the legacy path still works there).
 */
export function initStorage(dataDir: string | undefined, legacy = LEGACY_HOME): { home: string; migrated: string[] } {
  home = dataDir || legacy;
  const migrated = home === legacy ? [] : migrateLegacyHome(home, legacy);
  return { home, migrated };
}

/** The folder ledger.ts and buyerId.ts build their paths from. */
export function storageHome(): string {
  if (!home) throw new Error("MailPoppy storage was used before initStorage() — this is a bug in the sidecar.");
  return home;
}

/** `existsSync` that can't throw — see the 🪤 note at the top. */
export function exists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Copy a pre-0.1.16 ~/.mailpoppy into the new home, once: the ledger and the buyer id.
 * Per-file and never overwriting, so re-running is a no-op and newer data in the new home
 * always wins. Swallows everything — a denied read (confined backend), a missing legacy
 * folder, one unreadable file — none may stop the sidecar. Returns the names copied.
 */
export function migrateLegacyHome(target: string, legacy = LEGACY_HOME): string[] {
  const copied: string[] = [];
  try {
    if (!exists(legacy) || target === legacy) return copied;
    mkdirSync(target, { recursive: true });
    for (const name of STATE_FILES) {
      const src = join(legacy, name);
      const dest = join(target, name);
      if (!exists(src) || exists(dest)) continue;
      try {
        copyFileSync(src, dest);
        copied.push(name);
      } catch {
        /* one unreadable file must not stop the other */
      }
    }
  } catch {
    /* migration is best-effort, never fatal */
  }
  return copied;
}
