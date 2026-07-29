import { useState } from "react";
import {
  KeyRound,
  ExternalLink,
  Eye,
  EyeOff,
  ShieldCheck,
  RefreshCw,
  AlertTriangle,
  Terminal,
  Lock,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { setAwsCredentials as defaultSubmit, type AwsCredentialInput, type Readiness } from "../lib/awsCredentials";
import { Button, Spinner, cn, ExtLink } from "../ui";
import { friendlyError } from "../lib/errors";

// Shown on Setup → Step 0 when no AWS credentials resolve. Two jobs:
//  (a) hand-hold a newcomer who has no AWS account yet (what it is, rough cost,
//      how to make an account + a *scoped* IAM user + keys), and
//  (b) connect — two ways, in deliberate trust order:
//      • RECOMMENDED: `aws configure --profile mailpoppy` (or SSO). The secret
//        never enters MailPoppy's UI — it lives in ~/.aws and only the open-source
//        sidecar reads it, via the SDK credential chain.
//      • Convenience: paste the keys here. They're saved to ~/.aws/credentials and
//        never uploaded, but unlike the CLI path they pass through the (closed) app.
// We can't create the AWS account for them (AWS needs their own email + card), so
// this is a guided path, not automation.

const AWS_SIGNUP = "https://aws.amazon.com/free/";
const IAM_CONSOLE = "https://console.aws.amazon.com/iam/home#/users";
const POLICY_FILE =
  "https://github.com/leonct74/mailpoppy/blob/main/infra/policies/mailpoppy-provisioning-policy.json";
const DEPLOY_POLICY_FILE =
  "https://github.com/leonct74/mailpoppy/blob/main/infra/policies/mailpoppy-deploy-policy.json";
const AWS_CLI_INSTALL = "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

const CONFIGURE_CMD = "aws configure --profile mailpoppy";

const inputCls =
  "w-full rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 font-mono text-sm text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50";
const linkCls = "inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline";
const noAutoCap = { autoCapitalize: "off", autoCorrect: "off", spellCheck: false } as const;

export interface AwsOnboardingProps {
  /** Apply the readiness returned after saving keys (so the wizard updates). */
  onResult: (r: Readiness) => void;
  /** Re-run the environment check (for the recommended CLI/SSO path). */
  onRecheck: () => void;
  /** Whether the AWS CLI was detected — tailors the recommended path's hint. */
  cliInstalled?: boolean;
  /** Injectable for tests. */
  submit?: (input: AwsCredentialInput) => Promise<Readiness>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-container/20 font-mono text-[11px] font-semibold text-primary">
        {n}
      </span>
      <div className="text-sm text-on-surface-variant">
        <span className="font-medium text-on-surface">{title}</span> {children}
      </div>
    </li>
  );
}

export function AwsOnboarding({ onResult, onRecheck, cliInstalled, submit = defaultSubmit }: AwsOnboardingProps) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = accessKeyId.trim().length > 0 && secretAccessKey.trim().length > 0 && !busy;

  function copyCmd() {
    navigator.clipboard?.writeText(CONFIGURE_CMD).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  async function onConnect() {
    setBusy(true);
    setError(null);
    try {
      const r = await submit({
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
        sessionToken: sessionToken.trim() || undefined,
      });
      if (!r.credentials.ok) {
        // Keys were saved but AWS rejected them — keep the form, explain why.
        setError(
          r.credentials.error
            ? `AWS didn't accept those keys: ${r.credentials.error}`
            : "AWS didn't accept those keys. Double-check the Access Key ID and Secret, then try again.",
        );
      }
      onResult(r);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest/60 p-5">
      <h3 className="flex items-center gap-2 text-base font-semibold text-on-surface">
        <KeyRound className="size-4 text-primary" /> Connect your AWS account
      </h3>
      <p className="mt-1 text-sm text-on-surface-variant">
        MailPoppy runs entirely in <b className="text-on-surface">your own</b> AWS account, so your mail stays your
        property. You only need to do this once.
      </p>

      {/* Least-privilege guidance — bounds what MailPoppy can ever do, regardless of how you connect */}
      <div className="mt-4 flex items-start gap-2 rounded-lg border border-secondary/20 bg-secondary/5 p-3 text-sm text-on-surface-variant">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-secondary" />
        <span>
          <b className="text-on-surface">Use a dedicated, least-privilege key — never your account root.</b> Create an
          IAM user scoped to MailPoppy&apos;s two policies — the{" "}
          <ExtLink className={linkCls} href={POLICY_FILE}>
            provisioning policy <ExternalLink className="size-3" />
          </ExtLink>{" "}
          (day-to-day operation) and the{" "}
          <ExtLink className={linkCls} href={DEPLOY_POLICY_FILE}>
            deploy policy <ExternalLink className="size-3" />
          </ExtLink>{" "}
          (one-time backend creation). Together they cap what MailPoppy can ever do in your account, and you can revoke
          them any time.
        </span>
      </div>

      {/* New-to-AWS guidance (applies to either connect method) */}
      <ol className="mt-4 space-y-3">
        <Step n={1} title="Create a free AWS account (if you don't have one).">
          <ExtLink className={linkCls} href={AWS_SIGNUP}>
            aws.amazon.com/free <ExternalLink className="size-3" />
          </ExtLink>
          . It asks for an email and a card for verification, but there's a 12-month free tier — and the email
          infrastructure it creates typically costs just cents per month (often nothing, within the free tier), billed by
          AWS. <b className="text-on-surface">You pay AWS directly; never us.</b>
        </Step>
        <Step n={2} title="Create an IAM user and an access key.">
          In the{" "}
          <ExtLink className={linkCls} href={IAM_CONSOLE}>
            AWS console → IAM → Users <ExternalLink className="size-3" />
          </ExtLink>
          , add a user, attach both MailPoppy policies —{" "}
          <ExtLink className={linkCls} href={POLICY_FILE}>
            provisioning
          </ExtLink>{" "}
          and{" "}
          <ExtLink className={linkCls} href={DEPLOY_POLICY_FILE}>
            deploy
          </ExtLink>{" "}
          (recommended) or <b className="text-on-surface">AdministratorAccess</b> (broader) — then create an access key
          and copy the two values.
        </Step>
      </ol>

      {/* ── Step 3 — connect, using the access key from step 2. The CLI keeps the secret
          out of MailPoppy's window; the paste form below is the no-terminal alternative. ── */}
      <div className="mt-4 rounded-xl border border-primary/30 bg-primary-container/10 p-4">
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary-container/20 font-mono text-[11px] font-semibold text-primary">
            3
          </span>
          <h4 className="flex items-center gap-2 text-sm font-semibold text-on-surface">
            <Terminal className="size-4 text-primary" /> Connect with the AWS CLI
          </h4>
        </div>
        <p className="mt-1.5 text-sm text-on-surface-variant">
          This is <b className="text-on-surface">step 3</b> — do it once you&apos;ve created the access key in step 2
          (you&apos;ll paste that key at the prompt below).
        </p>
        <p className="mt-1 flex items-start gap-1.5 text-sm text-on-surface-variant">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-secondary" />
          <span>
            Your secret key <b className="text-on-surface">never enters MailPoppy&apos;s window</b>. It stays in your
            local <code className="font-mono">~/.aws</code> config and is read only by the open-source sidecar — exactly
            how the AWS CLI itself works.
          </span>
        </p>

        {cliInstalled === false && (
          <p className="mt-3 text-sm text-on-surface-variant">
            First, install the{" "}
            <ExtLink className={linkCls} href={AWS_CLI_INSTALL}>
              AWS CLI <ExternalLink className="size-3" />
            </ExtLink>
            . Then:
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-3 py-2 font-mono text-sm text-on-surface">
            {CONFIGURE_CMD}
          </code>
          <button
            type="button"
            onClick={copyCmd}
            aria-label="Copy command"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-outline-variant/30 text-on-surface-variant hover:text-on-surface"
          >
            {copied ? <Check className="size-4 text-secondary" /> : <Copy className="size-4" />}
          </button>
        </div>
        <p className="mt-2 text-sm text-on-surface-variant">
          Paste your two keys at the prompts (MailPoppy auto-detects the <code className="font-mono">mailpoppy</code>{" "}
          profile), then:
        </p>

        <Button className="mt-3" onClick={onRecheck} disabled={busy}>
          <RefreshCw className="size-3.5" /> Check connection
        </Button>

        <p className="mt-3 text-xs text-on-surface-variant/80">
          Using AWS SSO? Run <code className="font-mono">aws sso login</code> and launch MailPoppy with{" "}
          <code className="font-mono">AWS_PROFILE</code> set to your profile.
        </p>
      </div>

      {/* ── No-terminal alternative: paste keys directly. Kept secondary to the CLI
          (which keeps the secret out of the app), but a clearly visible button so a
          non-CLI user doesn't miss it. ── */}
      <button
        type="button"
        onClick={() => setShowPaste((s) => !s)}
        aria-expanded={showPaste}
        className="mt-4 flex w-full items-center justify-between gap-2 rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm font-medium text-on-surface transition-colors hover:border-primary/40 hover:bg-surface-container-low"
      >
        <span className="flex items-center gap-2">
          <KeyRound className="size-4 text-on-surface-variant" />
          No terminal? Paste your keys here instead
        </span>
        {showPaste ? (
          <ChevronDown className="size-4 text-on-surface-variant" />
        ) : (
          <ChevronRight className="size-4 text-on-surface-variant" />
        )}
      </button>

      {showPaste && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="flex items-start gap-1.5 rounded-lg border border-outline-variant/20 bg-surface-container-lowest p-3 text-xs text-on-surface-variant">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-tertiary" />
            <span>
              Convenient, but the keys you paste <b className="text-on-surface">pass through MailPoppy</b> before being
              saved to <code className="font-mono">~/.aws/credentials</code> on this computer. They&apos;re never
              uploaded to us — but if you&apos;d rather MailPoppy never touch your secret, use the CLI option above.
            </span>
          </p>

          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            Access Key ID
            <input
              value={accessKeyId}
              onChange={(e) => setAccessKeyId(e.target.value.trim())}
              placeholder="AKIA…"
              className={inputCls}
              disabled={busy}
              {...noAutoCap}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            Secret Access Key
            <div className="relative">
              <input
                value={secretAccessKey}
                onChange={(e) => setSecretAccessKey(e.target.value.trim())}
                type={showSecret ? "text" : "password"}
                placeholder="••••••••••••••••••••••••••••••••"
                className={cn(inputCls, "pr-10")}
                disabled={busy}
                {...noAutoCap}
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                aria-label={showSecret ? "Hide secret" : "Show secret"}
                className="absolute inset-y-0 right-2 flex items-center text-on-surface-variant hover:text-on-surface"
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-sm text-on-surface-variant">
            Session token <span className="text-xs text-on-surface-variant/70">(only for temporary STS keys)</span>
            <input
              value={sessionToken}
              onChange={(e) => setSessionToken(e.target.value.trim())}
              placeholder="optional"
              className={inputCls}
              disabled={busy}
              {...noAutoCap}
            />
          </label>

          {error && (
            <p className="flex items-start gap-1.5 text-sm text-tertiary">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={() => void onConnect()} disabled={!canSubmit}>
              {busy ? <Spinner /> : <KeyRound className="size-4" />} Connect
            </Button>
            <Button variant="secondary" size="sm" onClick={onRecheck} disabled={busy}>
              <RefreshCw className="size-3.5" /> Re-check
            </Button>
          </div>

          <p className="flex items-start gap-1.5 text-xs text-on-surface-variant">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-secondary" />
            Saved only on this computer, in the standard AWS location (
            <code className="font-mono">~/.aws/credentials</code>, owner-only permissions) — exactly where the AWS CLI
            keeps them. Never uploaded or sent to MailPoppy.
          </p>
        </div>
      )}
    </div>
  );
}
