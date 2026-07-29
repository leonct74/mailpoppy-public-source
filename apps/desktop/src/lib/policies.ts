// The two IAM policy documents, imported straight from the canonical infra files
// so there's a single source of truth (no drift): editing infra/policies/*.json is
// the only place these change. Bundled into the app at build time, so the
// "Copy policy" buttons work offline and remain available long after first setup —
// when the onboarding screen's links are no longer in view.
import provisioningPolicy from "../../../../infra/policies/mailpoppy-provisioning-policy.json";
import deployPolicy from "../../../../infra/policies/mailpoppy-deploy-policy.json";

export type PolicyTier = "provisioning" | "deploy";

export interface PolicyDoc {
  /** Human label, e.g. "provisioning policy". */
  label: string;
  /** Pretty-printed JSON ready to paste into the IAM console's JSON editor. */
  json: string;
}

export const POLICY_DOCS: Record<PolicyTier, PolicyDoc> = {
  provisioning: { label: "provisioning policy", json: JSON.stringify(provisioningPolicy, null, 2) },
  deploy: { label: "deploy policy", json: JSON.stringify(deployPolicy, null, 2) },
};
