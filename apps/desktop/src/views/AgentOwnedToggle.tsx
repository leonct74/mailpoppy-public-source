import { useEffect, useState } from "react";
import { getAgentOwned as defaultLoad, setAgentOwned as defaultSave, type MailboxAgentInfo } from "../lib/mailboxAgent";
import { Button } from "../ui";
import { friendlyError } from "../lib/errors";

// The agent-owned flag on one mailbox (the CrewPoppy bridge): when ON, mail
// arriving for this mailbox is handed to the admin's CrewPoppy agents so an
// email can start an agent run — normal delivery to the mailbox is unchanged.
//
// Switching it ON always runs through the inline disclosure below (webview-safe,
// no window.confirm) — an agent-owned mailbox is NOT private the way human
// mailboxes are, and the admin must see that in plain words before enabling.
// Switching OFF is immediate: reducing exposure needs no friction.
// load/save are injectable so the component is unit-tested without a sidecar.

const linkBtn = "text-xs text-primary underline-offset-2 hover:underline";

export function AgentOwnedToggle({
  email,
  stackName,
  load = defaultLoad,
  save = defaultSave,
}: {
  email: string;
  stackName: string;
  load?: (stackName: string, email: string) => Promise<MailboxAgentInfo>;
  save?: typeof defaultSave;
}) {
  const [on, setOn] = useState<boolean | null>(null); // null until loaded
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    load(stackName, email)
      .then((i) => alive && setOn(i.agentOwned))
      // Unknown state renders as OFF (the flag's own fail-safe default); a real
      // problem will surface when the admin tries to change it.
      .catch(() => alive && setOn(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, stackName]);

  async function apply(next: boolean) {
    setErr(null);
    setBusy(true);
    try {
      await save({ stackName, email, agentOwned: next });
      setOn(next);
      setConfirming(false);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  if (on === null) return null;

  return (
    <div className="mt-2">
      {on ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">🤖 Agent-owned</span>
          <span className="text-on-surface-variant">incoming mail is handed to your CrewPoppy agents.</span>
          <button onClick={() => void apply(false)} disabled={busy} className={linkBtn}>
            {busy ? "Turning off…" : "Turn off"}
          </button>
        </div>
      ) : !confirming ? (
        <button
          onClick={() => {
            setConfirming(true);
            setErr(null);
          }}
          className={linkBtn}
        >
          Hand incoming mail to CrewPoppy agents…
        </button>
      ) : (
        <div className="max-w-xl rounded-lg border border-warn/40 bg-warn/5 p-3">
          <div className="text-sm leading-relaxed text-on-surface-variant">
            Mail arriving for <b className="text-on-surface">{email}</b> will start your CrewPoppy agents (in your own
            AWS account) — so you can email this address an instruction from anywhere.{" "}
            <b className="text-on-surface">
              An agent-owned mailbox is NOT private the way human mailboxes are — its incoming mail is handed to an AI
              agent in plain text.
            </b>{" "}
            Your human mailboxes are unchanged. Only mail that passes authentication and comes from the agent&apos;s
            configured owner can start a run; if CrewPoppy isn&apos;t installed, mail simply delivers normally.
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={() => void apply(true)} disabled={busy}>
              {busy ? "Enabling…" : "Enable agent hand-off"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {err && <div className="mt-1.5 text-xs text-tertiary">{err}</div>}
    </div>
  );
}
