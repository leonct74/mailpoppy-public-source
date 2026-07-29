// Desktop client for the sidecar's teardown endpoint. Removes everything
// MailPoppy deployed for a domain (stack + RETAINed data + deploy bucket + SES
// identity + DNS). Long-running: the sidecar waits for CloudFormation to finish.
import { sidecar } from "./sidecar";

export interface TeardownResult {
  ok: true;
  domain: string;
  domains: string[];
  stackName: string;
  deleted: string[];
  warnings: string[];
}

/**
 * Tear down the WHOLE backend: the CloudFormation stack + its RETAINed data (mail
 * bucket, DynamoDB tables, Cognito pool) + the deploy bucket + every provisioned
 * domain's SES identity and DNS. `domain` is optional — when removing leftover
 * infrastructure after all domains are already gone, omit it and the sidecar
 * discovers + cleans any stragglers itself.
 */
export function teardownEverything(input: {
  domain?: string;
  stackName?: string;
  deleteDeployBucket?: boolean;
}): Promise<TeardownResult> {
  return sidecar("/teardown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** Read-only: every domain the backend was provisioned for (DNS/SES cleanup targets). */
export function listProvisionedDomains(stackName: string): Promise<{ ok: true; domains: string[] }> {
  return sidecar(`/teardown/domains/${encodeURIComponent(stackName)}`);
}

export interface RemoveDomainResult {
  ok: true;
  domain: string;
  stackName: string;
  deletedMailboxes: string[];
  deletedMessages: number;
  deletedObjects: number;
  freedBytes: number;
  sesIdentityDeleted: boolean;
  dnsRemoved: string[];
  warnings: string[];
}

/**
 * Mutating + DESTRUCTIVE, scoped to ONE domain: removes the domain's mailboxes
 * (+ their stored mail), its per-domain mail-rules/retention, its SES identity
 * and its DNS records — leaving the shared backend stack and every OTHER domain
 * intact. Unlike teardownEverything this does NOT touch CloudFormation, so it
 * returns quickly.
 */
export function removeDomain(input: { domain: string; stackName?: string }): Promise<RemoveDomainResult> {
  return sidecar("/domain/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
