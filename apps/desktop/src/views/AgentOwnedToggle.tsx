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
          <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">🤖 Assigned to an AI agent</span>
          <span className="text-on-surface-variant">incoming mail goes to your CrewPoppy agent.</span>
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
          Assign this mailbox to an AI agent…
        </button>
      ) : (
        <div className="max-w-xl rounded-lg border border-warn/40 bg-warn/5 p-3">
          <div className="text-sm leading-relaxed text-on-surface-variant">
            {/* Founder note (2026-07-29): say the prerequisite FIRST. Without it, a user
                who never installed CrewPoppy could flip this on expecting something to
                happen, and nothing would — a switch wired to nothing. */}
            <b className="text-on-surface">This needs CrewPoppy</b> — the AgentsPoppy app that runs AI agents in your
            own AWS account. If CrewPoppy isn&apos;t installed and set up, this switch does nothing: mail just delivers
            normally. With CrewPoppy, mail arriving for <b className="text-on-surface">{email}</b> starts the agent that
            owns this address — so you can email it an instruction from anywhere.{" "}
            <b className="text-on-surface">
              An agent mailbox is NOT private the way human mailboxes are — its incoming mail is handed to an AI agent
              in plain text.
            </b>{" "}
            Your human mailboxes are unchanged, and only mail that passes authentication and comes from your own
            address can start a run.
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="sm" onClick={() => void apply(true)} disabled={busy}>
              {busy ? "Assigning…" : "Assign to my AI agent"}
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
