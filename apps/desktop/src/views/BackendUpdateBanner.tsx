import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../ui";
import { backendVersion, type BackendVersion } from "../lib/deploy";

// An update to the backend is not a cosmetic app refresh — it changes the email engine
// running in the user's own AWS, and skipping one can eventually break the install (e.g.
// AWS retiring or changing a service the stack depends on). So an available update is
// announced app-wide, not only at the bottom of Account: this banner tells the user an
// update exists and lands them on Account → Backend to AUDIT it (provenance, diff, agent
// verification) and decide. It never applies anything itself — the human still gates that.

/** localStorage key holding the code key of the update the user muted. Keyed to the
 *  OFFERED update (`currentKey`), so muting is per-update: a newer update notifies again. */
const MUTE_KEY = "mailpoppy.backend-update-muted";

function mutedKey(): string | null {
  try {
    return localStorage.getItem(MUTE_KEY);
  } catch {
    return null; // storage unavailable — just show the banner
  }
}

export function BackendUpdateBanner({ hidden, onReview }: { hidden?: boolean; onReview: () => void }) {
  const [ver, setVer] = useState<BackendVersion | null>(null);
  const [ack, setAck] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Check on mount, and re-check whenever the banner becomes visible again (leaving the
  // Account tab after applying the update there) so it doesn't keep announcing a
  // just-applied update. Best-effort: on error stay silent — the Account → Backend panel
  // is the surface that reports version-check errors properly.
  useEffect(() => {
    if (hidden) return;
    let alive = true;
    backendVersion()
      .then((v) => {
        if (alive) setVer(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [hidden]);

  if (hidden || dismissed || !ver?.stackExists || !ver.updateAvailable) return null;
  if (mutedKey() === ver.currentKey) return null;

  function muteThisUpdate() {
    if (!ver) return;
    try {
      localStorage.setItem(MUTE_KEY, ver.currentKey);
    } catch {
      // storage unavailable — dismiss for this session only
    }
    setDismissed(true);
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-primary/20 bg-primary-container/10 px-6 py-2.5"
    >
      <span className="flex items-center gap-2 text-sm text-on-surface">
        <RefreshCw className="size-4 shrink-0 text-primary" />
        <span>
          <b>MailPoppy has a backend update</b>
          {ver.manifest?.summary ? <span className="text-on-surface-variant"> — {ver.manifest.summary}</span> : null}.
          Open Account, audit what it changes, and decide whether to apply it.
        </span>
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={onReview}>
          Review the update
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="size-3.5 accent-[var(--color-primary,#888)]"
          />
          I've reviewed it
        </label>
        <Button variant="ghost" size="sm" onClick={muteThisUpdate} disabled={!ack}>
          Don't show again
        </Button>
      </span>
    </div>
  );
}
