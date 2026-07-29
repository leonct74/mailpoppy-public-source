import { SlidersHorizontal } from "lucide-react";
import { resolveStackName } from "../lib/deploymentConfig";
import { SendingAccessView } from "./SendingAccessView";
import { SendSettingsEditor } from "./SendSettingsEditor";
import { ResourcesView } from "./ResourcesView";
import { BackendUpdate } from "./BackendUpdate";
import { Card } from "../ui";

// Account — the home for what's genuinely shared across the whole install rather
// than scoped to a single domain. There is ONE backend per install (one stack,
// one user pool, one SES rule set), so this is where the live inventory of what
// MailPoppy built, SES sending access (an AWS account+region property) and the
// install-wide send settings live. Per-domain concerns — DNS/DKIM, mailboxes,
// migration, inbox, mail rules + retention, and teardown — live in each domain's
// workspace instead. There is deliberately no "remove everything" control here;
// teardown is per-domain only. MailPoppy gets its AWS access automatically from
// AgentsPoppy (which packages it), so there's no credential panel to manage here.

export function AccountView({ stackName = resolveStackName() }: { stackName?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="font-mono text-xs uppercase tracking-wider text-primary">Account</div>
        <h2 className="mt-1 flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
          <SlidersHorizontal className="size-5 text-primary" />
          Account &amp; infrastructure
        </h2>
        <p className="mt-1 max-w-2xl text-on-surface-variant">
          Everything shared across all your domains — what MailPoppy set up in your AWS account, whether your domain
          can send to anyone, and a couple of install-wide settings. Mail rules and retention are set{" "}
          <b className="text-on-surface">per domain</b>, inside each domain's workspace.
        </p>
      </div>

      {/* The "what MailPoppy built in your cloud" summary card leads — then the
          ACTIONABLE panels slot in immediately after it (via afterSummary), ABOVE the
          long stack table + change log. Burying actions below hundreds of log rows made
          them effectively invisible; a pending backend update in particular must be seen. */}
      <ResourcesView
        stackName={stackName}
        afterSummary={
          <>
            {/* Backend updates — when a new app build ships an improved backend, apply it
                to the stack running in the user's own AWS (self-hides when there's no
                backend or it's already current). This is the ONLY channel for backend
                fixes to reach an existing install, so it gets top billing. */}
            <BackendUpdate />

            {/* Max outgoing attachment size — deployment-wide (one backend, one limit). */}
            <Card>
              <SendSettingsEditor stackName={stackName} />
            </Card>

            {/* Sending access is an AWS account+region property (SES sandbox →
                production), not per-domain — it lives here. */}
            <Card>
              <SendingAccessView />
            </Card>
          </>
        }
      />
    </div>
  );
}
