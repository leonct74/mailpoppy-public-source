import { useEffect, useRef, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { buildHelperPrompt } from "../lib/helper-prompt";
import { copyText } from "../lib/clipboard";
import { Button } from "../ui";

/**
 * "Copy the helper prompt" — the banner variant (AGENTS.md §9, REQUIRED on the primary
 * creation surface). Setting up mail on your own domain is the most intimidating thing
 * MailPoppy asks of anyone, so the onboarding IS a prompt: paste it into any AI, say who needs
 * email, get back the domain, the mailboxes and the boxes to tick.
 *
 * Pulses until it's first used — an invitation, not an alarm. The kit's `.poppy-helper-pulse`
 * holds perfectly still for anyone who asked their OS for reduced motion.
 */
export function HelperPromptBanner({ domain, region }: { domain?: string; region?: string }) {
  const [copied, setCopied] = useState(false);
  const [used, setUsed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  async function copy() {
    setErr(null);
    const ok = await copyText(buildHelperPrompt({ domain, region }));
    if (!alive.current) return;
    setUsed(true);
    if (!ok) {
      setErr("Couldn't reach the clipboard — try again, or set things up with the steps below.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => alive.current && setCopied(false), 2500);
  }

  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm leading-relaxed text-on-surface-variant">
          <b className="text-on-surface">New to setting up email?</b> Copy the helper prompt, paste it into any AI
          you already use (Claude, ChatGPT…), and finish its last sentence with who needs email addresses — it answers
          with the domain to enter, the mailboxes to create, and what to watch out for.
        </p>
        <Button size="sm" onClick={() => void copy()} className={used ? undefined : "poppy-helper-pulse"}>
          {copied ? (
            <>
              <Check className="size-3.5" /> Copied
            </>
          ) : (
            <>
              <Sparkles className="size-3.5" /> Copy the helper prompt
            </>
          )}
        </Button>
      </div>
      {err && <div className="mt-1.5 text-xs text-tertiary">{err}</div>}
    </div>
  );
}
