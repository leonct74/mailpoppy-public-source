import { useEffect, useState, type ReactNode } from "react";
import { Sparkles, RefreshCw, ExternalLink, X } from "lucide-react";
import {
  loadInventory as defaultLoad,
  groupByService,
  awsConsoleUrl,
  ledgerConsoleUrl,
  type Inventory,
} from "../lib/resources";
import { resolveStackName } from "../lib/deploymentConfig";
import { Card, Button, Spinner, cn, ExtLink } from "../ui";
import { friendlyError } from "../lib/errors";

// "What MailPoppy did to your account" (DESIGN §14.1). Shows the authoritative
// CloudFormation inventory of the deployed stack — grouped by service, every
// resource name with a console deep-link — plus the local provisioning ledger of
// out-of-stack mutations (Route53 / SES identity / rule-set activation) as a
// created/deleted timeline. The whole point is trust: no surprise resources.
//
// Read-only by design: there is intentionally NO "remove everything" control
// here. Tearing the backend down all at once is too blunt (and too easy to
// trigger by accident), so teardown is per-domain only — each domain's workspace
// has its own scoped "remove this domain" danger zone.

type Action = "created" | "deleted" | "updated";

/** Status chip — low-opacity hue + solid text (design "Status Chips" spec). */
function ActionChip({ action }: { action: Action }) {
  const tone =
    action === "created"
      ? "bg-secondary/10 text-secondary border-secondary/20"
      : action === "updated"
        ? "bg-surface-bright text-on-surface border-outline-variant/30"
        : "bg-tertiary-container/15 text-tertiary border-tertiary/20";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-xs", tone)}>
      {action === "deleted" ? (
        <X className="size-3" />
      ) : (
        <span className={cn("size-1.5 rounded-full", action === "created" ? "bg-secondary" : "bg-on-surface-variant")} />
      )}
      {action}
    </span>
  );
}

function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-outline-variant/5 bg-surface-container-highest/50 p-4">
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">{label}</div>
      <div className="text-2xl font-semibold tracking-tight text-on-surface">{value}</div>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th className={cn("border-b border-outline-variant/10 px-4 py-3 text-left font-mono text-xs font-medium uppercase tracking-wider text-on-surface-variant", className)}>
      {children}
    </th>
  );
}
function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn("border-b border-outline-variant/5 px-4 py-3 align-top text-sm", className)}>{children}</td>;
}

const consoleLink = "inline-flex items-center gap-1 text-primary hover:text-primary-container hover:underline";

export function ResourcesView({
  stackName = resolveStackName(),
  load = defaultLoad,
  afterSummary,
}: {
  stackName?: string;
  load?: (stackName: string) => Promise<Inventory>;
  /** Rendered right after the "What MailPoppy did to your account" summary card — lets
   *  Account slot its actionable panels (backend update, send settings) ABOVE the long
   *  stack table + change log, where the user actually sees them. */
  afterSummary?: ReactNode;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setInv(await load(stackName));
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackName]);

  const grouped = inv ? groupByService(inv.resources) : [];
  const ledger = inv ? [...inv.ledger].sort((a, b) => (a.ts < b.ts ? 1 : -1)) : [];

  return (
    <section className="flex flex-col gap-6">
      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-on-surface">
              <Sparkles className="size-5 text-primary" />
              What MailPoppy did to your account
            </h2>
            <p className="mt-1 max-w-2xl text-on-surface-variant">
              Everything MailPoppy created in your own AWS account — read live from CloudFormation, plus a local log of
              DNS/SES changes. Verify any of it in your console.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Spinner /> : <RefreshCw className="size-4" />}
            Refresh
          </Button>
        </div>

        {/* Provisioning summary stats (real counts from the live inventory + ledger). */}
        {inv && inv.stackExists && (
          <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile label="Stack resources" value={inv.resources.length} />
            <StatTile label="AWS services" value={grouped.length} />
            <StatTile label="DNS / SES changes" value={ledger.length} />
            <StatTile label="Region" value={<span className="font-mono text-lg">{inv.region}</span>} />
          </div>
        )}
      </Card>

      {/* Actionable account panels slot in here — above the long tables below. */}
      {afterSummary}

      {error && (
        <Card className="border-tertiary/30 bg-tertiary-container/10">
          <div className="text-tertiary">Couldn’t read your account: {error}</div>
          <div className="mt-1.5 text-sm text-on-surface-variant">
            Make sure the provisioning helper is running and your AWS credentials are set.
          </div>
        </Card>
      )}

      {inv && !inv.stackExists && (
        <Card className="bg-surface-container/60">
          <strong className="text-on-surface">No MailPoppy backend is deployed</strong> in{" "}
          <code className="font-mono text-sm text-on-surface-variant">{inv.region}</code> (stack{" "}
          <code className="font-mono text-sm text-on-surface-variant">{inv.stackName}</code> not found). Nothing is running
          in your account from the backend stack.
          {ledger.length === 0 && " The change log below is empty too."}
        </Card>
      )}

      {inv && inv.stackExists && (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-outline-variant/10 bg-surface-container-low/50 p-5">
            <strong className="text-on-surface">Deployed stack: {inv.stackName}</strong>
            <span className="font-mono text-xs text-on-surface-variant">
              {inv.resources.length} resources · {inv.region}
            </span>
          </div>
          <div className="p-5">
            {grouped.map((g) => (
              <div key={g.service} className="mt-5 first:mt-0">
                <div className="mb-2 text-sm font-semibold text-on-surface">
                  {g.service} <span className="font-normal text-on-surface-variant">({g.items.length})</span>
                </div>
                <table className="w-full border-collapse">
                  <thead>
                    <tr>
                      <Th>Name</Th>
                      <Th>Type</Th>
                      <Th>Status</Th>
                      <Th>Console</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((r) => {
                      const url = awsConsoleUrl(r.type, r.physicalId, inv.region);
                      return (
                        <tr key={r.logicalId} className="transition-colors hover:bg-on-surface/5">
                          <Td className="break-all font-mono text-xs text-on-surface">{r.physicalId || r.logicalId}</Td>
                          <Td className="text-xs text-on-surface-variant">{r.type}</Td>
                          <Td className="text-xs text-on-surface-variant">{r.status}</Td>
                          <Td>
                            {url ? (
                              <ExtLink href={url} className={consoleLink}>
                                Open <ExternalLink className="size-3" />
                              </ExtLink>
                            ) : (
                              <span className="text-on-surface-variant/50">—</span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Out-of-stack change log (created/deleted) */}
      <Card className="p-0">
        <div className="border-b border-outline-variant/10 bg-surface-container-low/50 p-5">
          <strong className="text-on-surface">Change log</strong>
          <span className="ml-2 text-sm text-on-surface-variant">DNS / SES — outside the stack</span>
        </div>
        {ledger.length === 0 ? (
          <p className="p-5 text-sm text-on-surface-variant">No direct DNS/SES changes recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="bg-surface-container-low">
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Service</Th>
                  <Th>Resource</Th>
                  <Th>Name</Th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((e, i) => {
                  const url = ledgerConsoleUrl(e);
                  const deleted = e.action === "deleted";
                  return (
                    <tr key={`${e.ts}-${i}`} className="transition-colors hover:bg-on-surface/5">
                      <Td className={cn("whitespace-nowrap text-xs text-on-surface-variant", deleted && "line-through opacity-60")}>
                        {new Date(e.ts).toLocaleString()}
                      </Td>
                      <Td>
                        <ActionChip action={e.action} />
                      </Td>
                      <Td className={cn("text-xs", deleted ? "text-on-surface-variant/60" : "text-on-surface")}>{e.service}</Td>
                      <Td className="text-xs text-on-surface-variant">{e.resourceType}</Td>
                      <Td className="font-mono text-xs">
                        {url ? (
                          <ExtLink href={url} className={consoleLink}>
                            {e.name} <ExternalLink className="size-3" />
                          </ExtLink>
                        ) : (
                          <span className={deleted ? "text-on-surface-variant/60 line-through" : "text-on-surface"}>{e.name}</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}
