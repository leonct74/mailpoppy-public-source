// Desktop client for the sidecar's SES sandbox/production-access endpoints
// (admin-only — talks to the local sidecar with the admin's AWS credentials).
import { sidecar } from "./sidecar";
import type { SesAccountStatus, ProductionAccessRequest } from "@mailpoppy/core";

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
