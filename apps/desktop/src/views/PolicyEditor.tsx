import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { isValidListEntry, type SpamPolicy } from "@mailpoppy/core";
import { getSpamPolicy as defaultGet, setSpamPolicy as defaultSet } from "../lib/policy";
import { Button } from "../ui";
import { friendlyError } from "../lib/errors";

// "Mail rules" editor for the wizard: per-verdict actions (spam / auth-fail /
// virus → junk/tag/reject) + sender allow/block lists. The inbound-processor
// Lambda enforces these on incoming mail (block-list → allow-list → virus → spam
// → auth → clean). load/save are injectable so the view is unit-tested.

const selCls =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";
const taCls =
  "w-full resize-y rounded-lg border border-outline-variant/30 bg-surface-container-lowest p-2 font-mono text-sm text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";

const SPAM_OPTS = [
  { v: "junk", label: "Move to Junk" },
  { v: "tag", label: "Keep in Inbox (tagged)" },
  { v: "reject", label: "Reject (don't deliver)" },
] as const;
const AUTH_OPTS = [
  { v: "junk", label: "Move to Junk" },
  { v: "tag", label: "Keep in Inbox (tagged)" },
  { v: "reject", label: "Reject (don't deliver)" },
  { v: "allow", label: "Allow (treat as normal)" },
] as const;
const VIRUS_OPTS = [
  { v: "quarantine", label: "Quarantine in Junk" },
  { v: "reject", label: "Reject (don't deliver)" },
] as const;

function parseList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface PolicyEditorProps {
  stackName: string;
  /** When set, edits a per-domain override (`policy#<domain>`); omitted = the
   *  deployment-wide default (`policy#default`). */
  domain?: string;
  load?: (stackName: string, domain?: string) => Promise<SpamPolicy>;
  save?: (input: { stackName: string; policy: SpamPolicy; domain?: string }) => Promise<{ ok: true; policy: SpamPolicy }>;
}

export function PolicyEditor({ stackName, domain, load, save }: PolicyEditorProps) {
  const loadPolicy = load ?? defaultGet;
  const savePolicy = save ?? defaultSet;

  const [onVirus, setOnVirus] = useState<SpamPolicy["onVirus"]>("quarantine");
  const [onSpam, setOnSpam] = useState<SpamPolicy["onSpam"]>("junk");
  const [onAuthFail, setOnAuthFail] = useState<SpamPolicy["onAuthFail"]>("junk");
  const [allowText, setAllowText] = useState("");
  const [blockText, setBlockText] = useState("");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  function applyPolicy(p: SpamPolicy) {
    setOnVirus(p.onVirus);
    setOnSpam(p.onSpam);
    setOnAuthFail(p.onAuthFail);
    setAllowText(p.allowList.join("\n"));
    setBlockText(p.blockList.join("\n"));
  }

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      applyPolicy(await loadPolicy(stackName, domain));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackName, domain]);

  const allowList = parseList(allowText);
  const blockList = parseList(blockText);
  const invalid = [...allowList, ...blockList].filter((e) => !isValidListEntry(e));

  async function onSave() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const res = await savePolicy({ stackName, policy: { onVirus, onSpam, onAuthFail, allowList, blockList }, domain });
      applyPolicy(res.policy); // reflect server-normalized (deduped/lowercased) lists
      setSaved(true);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Mail rules">
      <h2 className="text-lg font-semibold text-on-surface">Mail rules — spam &amp; allow/block</h2>
      <p className="mt-1 text-sm text-on-surface-variant">
        How incoming mail is handled. Order: <b>block list</b> → <b>allow list</b> → virus → spam → failed
        authentication → clean. Changes apply to <b>newly received</b> mail
        {domain ? (
          <>
            {" "}addressed to <b className="text-on-surface">{domain}</b>
          </>
        ) : null}
        .
      </p>

      {loading && <p className="mt-3 text-sm text-on-surface-variant">Loading mail rules…</p>}

      {!loading && (
        <>
          {/* Everyday controls: per-sender allow/block lists. */}
          <div className="mt-4 flex flex-wrap gap-5">
            <label className="min-w-60 flex-1 text-sm font-semibold text-on-surface">
              Allow list <span className="font-normal text-on-surface-variant/70">(always inbox, skips spam/auth checks)</span>
              <textarea aria-label="Allow list" value={allowText} onChange={(e) => setAllowText(e.target.value)} rows={4} className={`mt-1.5 ${taCls}`} placeholder={"boss@partner.com\npartner.com"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </label>
            <label className="min-w-60 flex-1 text-sm font-semibold text-on-surface">
              Block list <span className="font-normal text-on-surface-variant/70">(rejected, never stored)</span>
              <textarea aria-label="Block list" value={blockText} onChange={(e) => setBlockText(e.target.value)} rows={4} className={`mt-1.5 ${taCls}`} placeholder={"spammer@bad.com\nbad.com"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </label>
          </div>
          <p className="mt-1 text-xs text-on-surface-variant/70">
            One entry per line — an address (<code className="font-mono text-on-surface-variant">a@b.com</code>), a domain (
            <code className="font-mono text-on-surface-variant">b.com</code>), or{" "}
            <code className="font-mono text-on-surface-variant">@b.com</code>.
          </p>

          {invalid.length > 0 && (
            <div className="mt-2 text-sm text-warn">
              These entries don't look like an address or domain and won't match anything:{" "}
              {invalid.map((e) => (
                <code key={e} className="mr-2 font-mono">{e}</code>
              ))}
            </div>
          )}

          {/* Advanced: per-verdict actions. Hidden by default with a "leave the
              defaults" recommendation so a non-technical admin won't break delivery. */}
          <div className="mt-4 border-t border-outline-variant/10 pt-3">
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              className="flex items-center gap-1 text-sm font-semibold text-primary"
            >
              {showAdvanced ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} Advanced: spam &amp; virus handling
            </button>

            {showAdvanced && (
              <div className="mt-2.5">
                <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn-bright">
                  <b>Recommended: leave these at their defaults.</b> Virus mail is quarantined and spam goes to Junk —
                  this suits almost everyone. Changing them can cause wanted mail to be hidden or lost. Only adjust these
                  if you know exactly why.
                </div>
                <div className="mt-3 flex flex-wrap gap-5">
                  <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
                    Spam →
                    <select aria-label="Spam action" value={onSpam} onChange={(e) => setOnSpam(e.target.value as SpamPolicy["onSpam"])} className={selCls}>
                      {SPAM_OPTS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
                    Failed SPF/DKIM/DMARC →
                    <select aria-label="Auth-fail action" value={onAuthFail} onChange={(e) => setOnAuthFail(e.target.value as SpamPolicy["onAuthFail"])} className={selCls}>
                      {AUTH_OPTS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
                    Virus →
                    <select aria-label="Virus action" value={onVirus} onChange={(e) => setOnVirus(e.target.value as SpamPolicy["onVirus"])} className={selCls}>
                      {VIRUS_OPTS.map((o) => (
                        <option key={o.v} value={o.v}>{o.label}</option>
                      ))}
                    </select>
                    <span className="text-xs font-normal text-on-surface-variant/70">A virus is never delivered to the inbox.</span>
                  </label>
                </div>
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => void onSave()} disabled={saving}>
              {saving ? "Saving…" : "Save mail rules"}
            </Button>
            {saved && <span className="text-sm text-secondary">✅ Saved — applies to new mail.</span>}
          </div>
        </>
      )}

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
    </section>
  );
}
