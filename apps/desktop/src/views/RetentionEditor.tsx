import { useEffect, useState } from "react";
import type { RetentionSettings } from "@mailpoppy/core";
import { getRetention as defaultGet, setRetention as defaultSet } from "../lib/retention";
import { Button } from "../ui";
import { friendlyError } from "../lib/errors";

// "How long mail is kept" editor. AWS never auto-deletes mail, so the safe default
// is keep-indefinitely (+ auto-purge Trash). A delete-after window is opt-in and
// clearly flagged as permanent, because some jurisdictions require data
// minimisation while others require minimum retention — it's the admin's call.

const numInput =
  "w-20 rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-2 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";

export interface RetentionEditorProps {
  stackName: string;
  /** When set, edits a per-domain override (`retention#<domain>`); omitted = the
   *  deployment-wide default (`retention#default`). */
  domain?: string;
  load?: (stackName: string, domain?: string) => Promise<RetentionSettings>;
  save?: (input: { stackName: string; retention: RetentionSettings; domain?: string }) => Promise<{ ok: true; retention: RetentionSettings }>;
}

export function RetentionEditor({ stackName, domain, load, save }: RetentionEditorProps) {
  const loadRetention = load ?? defaultGet;
  const saveRetention = save ?? defaultSet;

  const [trashPurgeDays, setTrashPurgeDays] = useState("30");
  const [keepForever, setKeepForever] = useState(true);
  const [retentionDays, setRetentionDays] = useState("365");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function apply(r: RetentionSettings) {
    setTrashPurgeDays(String(r.trashPurgeDays));
    setKeepForever(r.retentionDays === null);
    if (r.retentionDays !== null) setRetentionDays(String(r.retentionDays));
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        apply(await loadRetention(stackName, domain));
      } catch (e) {
        setErr(friendlyError(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackName, domain]);

  async function onSave() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const retention: RetentionSettings = {
        trashPurgeDays: Math.max(1, Math.floor(Number(trashPurgeDays) || 30)),
        retentionDays: keepForever ? null : Math.max(1, Math.floor(Number(retentionDays) || 0)) || null,
      };
      const res = await saveRetention({ stackName, retention, domain });
      apply(res.retention);
      setSaved(true);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Retention">
      <h2 className="text-lg font-semibold text-on-surface">Retention — how long mail is kept</h2>
      <p className="mt-1 text-sm text-on-surface-variant">
        AWS never deletes mail on its own — MailPoppy keeps it until you say otherwise. Some rules require a{" "}
        <i>minimum</i> retention, others a <i>maximum</i> — so this is your call.
        {domain ? (
          <>
            {" "}These settings apply to mail on <b className="text-on-surface">{domain}</b>.
          </>
        ) : null}
      </p>

      {loading && <p className="mt-3 text-sm text-on-surface-variant">Loading retention…</p>}

      {!loading && (
        <>
          <div className="mb-3 mt-4 text-sm text-on-surface">
            Empty the Trash automatically after{" "}
            <input aria-label="Trash purge days" value={trashPurgeDays} onChange={(e) => setTrashPurgeDays(e.target.value)} className={numInput} /> days.
          </div>

          <div className="text-sm text-on-surface">
            <div className="mb-2 font-semibold">Keep mail for how long?</div>
            <label className="mb-2 flex items-center gap-2">
              <input type="radio" name="ret" aria-label="Keep mail indefinitely" checked={keepForever} onChange={() => setKeepForever(true)} className="size-4 accent-primary" />
              Keep indefinitely <span className="text-xs text-on-surface-variant/70">(recommended — never auto-deleted)</span>
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="radio" name="ret" aria-label="Delete mail after a set time" checked={!keepForever} onChange={() => setKeepForever(false)} className="size-4 accent-primary" />
              Delete mail older than{" "}
              <input
                aria-label="Retention days"
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                disabled={keepForever}
                className={numInput}
              />{" "}
              days
            </label>
          </div>

          {!keepForever && (
            <div className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn-bright">
              ⚠️ This <b>permanently deletes</b> any mail older than {Math.max(1, Math.floor(Number(retentionDays) || 0)) || "—"} days, in
              every folder, on the next daily cleanup. Make sure this matches the rules that apply to your users.
            </div>
          )}

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => void onSave()} disabled={saving}>
              {saving ? "Saving…" : "Save retention"}
            </Button>
            {saved && <span className="text-sm text-secondary">✅ Saved.</span>}
          </div>
        </>
      )}

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
    </section>
  );
}
