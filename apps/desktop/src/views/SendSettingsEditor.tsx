import { useEffect, useState } from "react";
import {
  type SendSettings,
  formatBytes,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  MIN_MAX_ATTACHMENT_BYTES,
  MAX_MAX_ATTACHMENT_BYTES,
} from "@mailpoppy/core";
import { getSendSettings as defaultGet, setSendSettings as defaultSet } from "../lib/sendSettings";
import { Button } from "../ui";
import { friendlyError } from "../lib/errors";

// "Max attachment size" editor — deployment-wide. Large files are uploaded
// straight to S3 (presigned PUT) and assembled into the message server-side, so
// the only real ceiling is SES's 40 MB total-message limit. The admin picks a cap
// in MB; the value is clamped to 1–40 MB server-side.

const MB = 1024 * 1024;
const numInput =
  "w-20 rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-2 py-1.5 text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";

export interface SendSettingsEditorProps {
  stackName: string;
  load?: (stackName: string) => Promise<SendSettings>;
  save?: (input: { stackName: string; maxAttachmentBytes: number }) => Promise<{ ok: true; settings: SendSettings }>;
}

const MIN_MB = Math.round(MIN_MAX_ATTACHMENT_BYTES / MB);
const MAX_MB = Math.round(MAX_MAX_ATTACHMENT_BYTES / MB);
const DEFAULT_MB = Math.round(DEFAULT_MAX_ATTACHMENT_BYTES / MB);

export function SendSettingsEditor({ stackName, load, save }: SendSettingsEditorProps) {
  const loadSettings = load ?? defaultGet;
  const saveSettings = save ?? defaultSet;

  const [maxMb, setMaxMb] = useState(String(DEFAULT_MB));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const s = await loadSettings(stackName);
        setMaxMb(String(Math.round(s.maxAttachmentBytes / MB)));
      } catch (e) {
        setErr(friendlyError(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackName]);

  async function onSave() {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const mb = Math.min(MAX_MB, Math.max(MIN_MB, Math.floor(Number(maxMb) || DEFAULT_MB)));
      const res = await saveSettings({ stackName, maxAttachmentBytes: mb * MB });
      setMaxMb(String(Math.round(res.settings.maxAttachmentBytes / MB)));
      setSaved(true);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Attachment size">
      <h2 className="text-lg font-semibold text-on-surface">Outgoing attachments — maximum size</h2>
      <p className="mt-1 max-w-2xl text-sm text-on-surface-variant">
        The largest total attachment size your users can add to one outgoing email. Files are uploaded directly to
        your S3 bucket, so the only hard ceiling is Amazon SES's {formatBytes(MAX_MAX_ATTACHMENT_BYTES)} total-message
        limit. Applies to every mailbox on this backend.
      </p>

      {loading && <p className="mt-3 text-sm text-on-surface-variant">Loading…</p>}

      {!loading && (
        <>
          <div className="mb-1 mt-4 flex flex-wrap items-center gap-2 text-sm text-on-surface">
            Limit attachments to{" "}
            <input
              aria-label="Max attachment size in MB"
              value={maxMb}
              onChange={(e) => setMaxMb(e.target.value)}
              className={numInput}
              inputMode="numeric"
            />{" "}
            MB per message.
          </div>
          <p className="text-xs text-on-surface-variant/70">
            Between {MIN_MB} and {MAX_MB} MB (default {DEFAULT_MB} MB).
          </p>

          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => void onSave()} disabled={saving}>
              {saving ? "Saving…" : "Save limit"}
            </Button>
            {saved && <span className="text-sm text-secondary">✅ Saved.</span>}
          </div>
        </>
      )}

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
    </section>
  );
}
