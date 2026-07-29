import { useEffect, useMemo, useState } from "react";
import { friendlyError } from "../lib/errors";
import {
  sendingAccessState,
  validateProductionAccessRequest,
  type SesAccountStatus,
  type ProductionAccessRequest,
  type MailType,
  type ContactLanguage,
} from "@mailpoppy/core";
import {
  getSesAccount as defaultGetSesAccount,
  requestProductionAccess as defaultRequestProductionAccess,
} from "../lib/sesAccount";
import { Button } from "../ui";

// "Sending access" panel for the setup wizard. Every AWS account starts SES in a
// "sandbox": you can only send to verified addresses, ~200 msgs/day. To run real
// mail the admin must request production access (a manual AWS review). This shows
// the current posture and submits the request in-app. load/submit are injectable
// so the view is unit-tested without a live sidecar.

const inputCls =
  "rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 text-sm font-normal text-on-surface placeholder:text-outline-variant focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";

type Tone = "success" | "info" | "danger" | "warn" | "neutral";
const bannerCls: Record<Tone, string> = {
  success: "border-secondary/30 bg-secondary/10 text-secondary",
  info: "border-primary/30 bg-primary/10 text-primary",
  danger: "border-tertiary/30 bg-tertiary-container/15 text-tertiary",
  warn: "border-warn/30 bg-warn/10 text-warn-bright",
  neutral: "border-outline-variant/20 bg-surface-container-lowest text-on-surface-variant",
};
function Banner({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2.5 text-sm ${bannerCls[tone]}`}>{children}</div>;
}

const DEFAULT_USE_CASE =
  "We use Amazon SES to host email for our own domain — sending and receiving normal " +
  "business correspondence for our staff mailboxes. Recipients are our own contacts and " +
  "people who email us; we are not sending bulk or marketing email.";

export interface SendingAccessViewProps {
  /** Prefill the website URL (e.g. the domain being set up). */
  defaultWebsite?: string;
  load?: () => Promise<SesAccountStatus>;
  submit?: (req: ProductionAccessRequest) => Promise<SesAccountStatus>;
}

export function SendingAccessView({ defaultWebsite, load, submit }: SendingAccessViewProps) {
  const loadAccount = load ?? defaultGetSesAccount;
  const submitRequest = submit ?? defaultRequestProductionAccess;

  const [account, setAccount] = useState<SesAccountStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Request form
  const [mailType, setMailType] = useState<MailType>("TRANSACTIONAL");
  const [websiteUrl, setWebsiteUrl] = useState(defaultWebsite ? `https://${defaultWebsite}` : "");
  const [useCase, setUseCase] = useState(DEFAULT_USE_CASE);
  const [language, setLanguage] = useState<ContactLanguage>("EN");
  const [extraEmails, setExtraEmails] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      setAccount(await loadAccount());
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the prefill in sync if the domain becomes known after mount.
  useEffect(() => {
    if (defaultWebsite && !websiteUrl) setWebsiteUrl(`https://${defaultWebsite}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultWebsite]);

  const state = sendingAccessState(account);
  const req: ProductionAccessRequest = useMemo(
    () => ({
      mailType,
      websiteUrl,
      useCaseDescription: useCase,
      contactLanguage: language,
      additionalContactEmails: extraEmails
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    }),
    [mailType, websiteUrl, useCase, language, extraEmails],
  );
  const problems = useMemo(() => validateProductionAccessRequest(req), [req]);

  async function doSubmit() {
    setSubmitting(true);
    setErr(null);
    try {
      setAccount(await submitRequest(req));
      setConfirming(false);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const showForm = state === "sandbox" || state === "denied";

  return (
    <section aria-label="Sending access">
      <h2 className="flex items-center gap-2 text-lg font-semibold text-on-surface">
        Sending access (SES sandbox)
        {showForm && (
          <span className="rounded-full border border-tertiary/30 bg-tertiary-container/15 px-2 py-0.5 text-xs font-semibold text-tertiary">
            Required to email anyone
          </span>
        )}
      </h2>

      {loading && <p className="mt-2 text-sm text-on-surface-variant">Checking your SES account…</p>}

      {!loading && account && (
        <div className="mt-3 flex flex-col gap-2">
          {state === "production" && (
            <Banner tone="success">
              ✅ <b>Production access granted.</b> You can send email to any recipient.
            </Banner>
          )}
          {state === "pending" && (
            <Banner tone="info">
              ⏳ <b>Production access requested.</b> AWS is reviewing your request — this usually takes under 24 hours.
              You'll get an email at your AWS account's address when it's decided. Until then you can only send to verified
              addresses.
            </Banner>
          )}
          {state === "denied" && (
            <Banner tone="danger">
              ⚠️ <b>AWS did not approve the request.</b> Check the email AWS sent for the reason, adjust the details below,
              and submit again.
            </Banner>
          )}
          {state === "disabled" && (
            <Banner tone="danger">
              ⛔ <b>Sending is paused on your account</b> (enforcement status{" "}
              <code className="font-mono">{account.enforcementStatus ?? "unknown"}</code>). Resolve this in the AWS SES
              console before requesting production access.
            </Banner>
          )}
          {state === "sandbox" && (
            <Banner tone="warn">
              🟡 <b>Your SES account is in the sandbox.</b> You can send only to <i>verified</i> addresses, with a small
              daily cap. To send real mail to anyone, request production access below.
            </Banner>
          )}

          {account.sendQuota && (
            <p className="text-sm text-on-surface-variant">
              Daily sending: <b className="text-on-surface">{account.sendQuota.sentLast24Hours}</b> of{" "}
              <b className="text-on-surface">{account.sendQuota.max24Hour.toLocaleString()}</b> in the last 24h · max{" "}
              <b className="text-on-surface">{account.sendQuota.maxSendRate}</b>/sec
            </p>
          )}
        </div>
      )}

      {showForm && (
        <div className="mt-3">
          <p className="mb-2.5 text-sm text-on-surface-variant">
            AWS reviews this manually (usually within 24h). Be specific — vague descriptions get rejected.
          </p>

          <fieldset className="m-0 rounded-lg border border-outline-variant/10 p-4">
            <div className="mb-3">
              <span className="text-sm font-semibold text-on-surface">Mail type</span>
              <div className="mt-1.5 flex flex-wrap gap-4 text-sm text-on-surface">
                <label className="flex items-center gap-2">
                  <input type="radio" name="mailType" checked={mailType === "TRANSACTIONAL"} onChange={() => setMailType("TRANSACTIONAL")} className="size-4 accent-primary" />
                  Transactional <span className="text-xs text-on-surface-variant/70">(your own correspondence — pick this)</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="mailType" checked={mailType === "MARKETING"} onChange={() => setMailType("MARKETING")} className="size-4 accent-primary" />
                  Marketing
                </label>
              </div>
            </div>

            <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
              Website URL
              <input
                aria-label="Website URL"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value.trim())}
                placeholder="https://yourdomain.com"
                className={`${inputCls} w-80`}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </label>

            <div className="mt-3">
              <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
                How you'll use email
                <textarea
                  aria-label="Use case description"
                  value={useCase}
                  onChange={(e) => setUseCase(e.target.value)}
                  rows={4}
                  className={`${inputCls} w-full resize-y`}
                />
              </label>
              <span className="text-xs text-on-surface-variant/70">{useCase.trim().length} characters</span>
            </div>

            <div className="mt-3 flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5 text-sm font-semibold text-on-surface">
                Contact language
                <select aria-label="Contact language" value={language} onChange={(e) => setLanguage(e.target.value as ContactLanguage)} className={inputCls}>
                  <option value="EN">English</option>
                  <option value="JA">Japanese</option>
                </select>
              </label>
              <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-sm font-semibold text-on-surface">
                Extra contact emails <span className="font-normal text-on-surface-variant/70">(optional, comma-separated)</span>
                <input
                  aria-label="Additional contact emails"
                  value={extraEmails}
                  onChange={(e) => setExtraEmails(e.target.value)}
                  placeholder="ops@yourdomain.com"
                  className={`${inputCls} w-full`}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
            </div>
          </fieldset>

          {problems.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm text-warn">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {!confirming ? (
            <Button className="mt-2.5" onClick={() => setConfirming(true)} disabled={problems.length > 0 || submitting}>
              Request production access
            </Button>
          ) : (
            <div className="mt-2.5">
              <Banner tone="neutral">
                This submits a request to <b className="text-on-surface">AWS</b> (it opens a Support case AWS reviews).
                Continue?
                <div className="mt-2 flex items-center gap-2">
                  <Button size="sm" onClick={() => void doSubmit()} disabled={submitting}>
                    {submitting ? "Submitting…" : "Submit to AWS"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={submitting}>
                    Cancel
                  </Button>
                </div>
              </Banner>
            </div>
          )}
        </div>
      )}

      {err && <p className="mt-2 text-sm text-tertiary">{err}</p>}
    </section>
  );
}
