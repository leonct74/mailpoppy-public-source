// Desktop client for the sidecar's agent-owned mailbox endpoints (the CrewPoppy
// bridge): read whether a mailbox hands its inbound mail to the admin's CrewPoppy
// agents, and flag/unflag it. Admin-only (talks to the local sidecar).
import { sidecar } from "./sidecar";

export interface MailboxAgentInfo {
  email: string;
  agentOwned: boolean;
}

export function getAgentOwned(stackName: string, email: string): Promise<MailboxAgentInfo> {
  return sidecar(`/mailbox/agent/${encodeURIComponent(stackName)}/${encodeURIComponent(email)}`);
}

export function setAgentOwned(input: {
  stackName?: string;
  email: string;
  agentOwned: boolean;
}): Promise<{ ok: true; email: string; agentOwned: boolean }> {
  return sidecar("/mailbox/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
