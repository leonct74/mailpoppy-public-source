// Desktop client for the sidecar's per-domain provisioning status. A domain's
// SES identity (DKIM) + "can it send yet" live behind /provision/:domain/status;
// the wizard polls this during setup and the Home dashboard reads it per domain.
import { sidecar } from "./sidecar";

export interface DomainIdentityStatus {
  /** SES says the identity is verified and allowed to send from this domain. */
  verifiedForSending: boolean;
  /** DKIM verification state, e.g. "SUCCESS" | "PENDING" | "FAILED" | "NOT_STARTED". */
  dkim: string;
}

/** Read a single domain's SES identity / DKIM status (read-only). */
export function getDomainIdentityStatus(domain: string): Promise<DomainIdentityStatus> {
  return sidecar(`/provision/${encodeURIComponent(domain)}/status`);
}
