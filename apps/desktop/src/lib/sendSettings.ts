// Desktop client for the sidecar's send-settings endpoints (admin-only — talks
// to the local sidecar with the admin's AWS credentials). The max attachment
// size is deployment-wide and enforced by the access-api Lambda (presign + send),
// which reads it from the settings table.
import { sidecar } from "./sidecar";
import type { SendSettings } from "@mailpoppy/core";

/** Read the deployment's send settings (defaults if never set). */
export function getSendSettings(stackName: string): Promise<SendSettings> {
  return sidecar(`/send/settings/${encodeURIComponent(stackName)}`);
}

/** Save the max attachment size (bytes). Normalized + clamped server-side. */
export function setSendSettings(input: {
  stackName?: string;
  maxAttachmentBytes: number;
}): Promise<{ ok: true; settings: SendSettings }> {
  return sidecar("/send/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
