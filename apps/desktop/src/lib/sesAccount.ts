// Desktop client for the sidecar's SES sandbox/production-access endpoints
// (admin-only — talks to the local sidecar with the admin's AWS credentials).
import { sidecar } from "./sidecar";
import type { SesAccountStatus, ProductionAccessRequest, RecipientVerification } from "@mailpoppy/core";

/** Read the account's current SES sending posture (sandbox vs production, quota). */
export function getSesAccount(): Promise<SesAccountStatus> {
  return sidecar("/ses/account");
}

/** Submit a production-access (sandbox-exit) request to AWS. Mutating — confirm first. */
export function requestProductionAccess(req: ProductionAccessRequest): Promise<SesAccountStatus> {
  return sidecar("/ses/production-access", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** Read-only: where a recipient address stands in SES's verification flow. */
export function getRecipientVerification(email: string): Promise<RecipientVerification> {
  return sidecar(`/ses/recipient/${encodeURIComponent(email)}`);
}

/** Start (or re-send) SES verification for a recipient — AWS emails it a click-link. */
export function verifyRecipient(email: string): Promise<RecipientVerification> {
  return sidecar("/ses/recipient/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
}
