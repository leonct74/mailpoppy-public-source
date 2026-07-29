import { useEffect, useState } from "react";
import { friendlyError } from "../lib/errors";
import {
  getRegion as defaultGet,
  setRegion as defaultSet,
  savedRegion,
  persistRegion,
  type RegionConfig,
} from "../lib/region";

// Lets the admin choose which AWS region hosts the mail infrastructure (and all
// stored mail) — data-residency is a legal requirement in some jurisdictions.
// Applies to a NEW deployment; an existing stack can't be moved, so when a backend
// is already deployed we show its region locked. load/save injectable for tests.

const selCls =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";

// Friendly labels for the SES-inbound regions (the only ones where receiving works).
const REGION_LABELS: Record<string, string> = {
  "eu-west-1": "EU (Ireland) — eu-west-1",
  "us-east-1": "US East (N. Virginia) — us-east-1",
  "us-west-2": "US West (Oregon) — us-west-2",
};
const label = (r: string) => REGION_LABELS[r] ?? r;

export interface RegionPickerProps {
  /** If a backend is already deployed, its region — the picker locks to it. */
  lockedRegion?: string;
  load?: () => Promise<RegionConfig>;
  save?: (region: string) => Promise<{ ok: true; region: string }>;
}

export function RegionPicker({ lockedRegion, load, save }: RegionPickerProps) {
  const loadRegion = load ?? defaultGet;
  const saveRegion = save ?? defaultSet;

  const [region, setRegionState] = useState<string>("");
  const [available, setAvailable] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await loadRegion();
        setAvailable(cfg.available);
        // Re-apply the admin's saved choice on launch (sidecar resets to its env default).
        const want = savedRegion();
        if (want && want !== cfg.region && cfg.available.includes(want)) {
          const r = await saveRegion(want);
          setRegionState(r.region);
        } else {
          setRegionState(cfg.region);
        }
      } catch (e) {
        setErr(friendlyError(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onChange(next: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await saveRegion(next);
      persistRegion(r.region);
      setRegionState(r.region);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <label className="block text-sm font-semibold text-on-surface">
        AWS region (where your mail is stored)
        <div className="mt-2 font-normal">
          {lockedRegion ? (
            <span className="text-sm">
              <code className="font-mono text-on-surface">{label(lockedRegion)}</code>{" "}
              <span className="text-xs text-on-surface-variant/70">· locked — already deployed here</span>
            </span>
          ) : (
            <select
              aria-label="AWS region"
              value={region}
              onChange={(e) => void onChange(e.target.value)}
              disabled={busy || available.length === 0}
              className={selCls}
            >
              {available.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          )}
        </div>
      </label>
      <p className="mt-2 max-w-xl text-xs text-on-surface-variant">
        Choose this <b className="text-on-surface">before deploying</b>. All received mail and attachments are stored in
        this region — pick the one your data-residency rules require (e.g. an EU region for EU personal data). A
        deployment can't be moved later; you'd tear down and redeploy elsewhere.
      </p>
      {err && <p className="mt-1 text-xs text-tertiary">{err}</p>}
    </div>
  );
}
