// Desktop client for the sidecar's mailbox storage endpoints: read a mailbox's
// usage (sum of stored bytes) + quota, and set/clear the quota. Admin-only
// (talks to the local sidecar with the admin's AWS credentials).
import { sidecar } from "./sidecar";

export interface MailboxStorageInfo {
  email: string;
  usedBytes: number;
  messageCount: number;
  quotaBytes: number | null;
}

export function getMailboxStorage(stackName: string, email: string): Promise<MailboxStorageInfo> {
  return sidecar(`/mailbox/storage/${encodeURIComponent(stackName)}/${encodeURIComponent(email)}`);
}

export function setMailboxQuota(input: {
  stackName?: string;
  email: string;
  quotaBytes: number | null;
}): Promise<{ ok: true; email: string; quotaBytes: number | null }> {
  return sidecar("/mailbox/quota", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
