import { sidecar } from "./sidecar";

// Live AWS capability tiers for the "permissions lights" indicator. Backed by the
// sidecar's iam:SimulatePrincipalPolicy probe — real effective permissions, not a
// guess at attached policy names.

export type CapStatus = "allowed" | "denied" | "unknown";

export interface Capabilities {
  operate: CapStatus;
  deploy: CapStatus;
  /** false when the identity can't run the simulation (lacks iam:SimulatePrincipalPolicy). */
  checkable: boolean;
  /** false when no usable AWS credentials resolved yet (nothing connected). */
  connected: boolean;
  arn?: string;
}

export function getCapabilities(): Promise<Capabilities> {
  return sidecar<Capabilities>("/aws/capabilities");
}

const REPO = "https://github.com/leonct74/mailpoppy/blob/main/infra/policies";
export const PROVISIONING_POLICY_URL = `${REPO}/mailpoppy-provisioning-policy.json`;
export const DEPLOY_POLICY_URL = `${REPO}/mailpoppy-deploy-policy.json`;

export interface CapTier {
  key: "operate" | "deploy";
  label: string;
  status: CapStatus;
  /** Plain-language meaning of the current status. */
  detail: string;
  /** When denied: the policy to attach, with a link. */
  fixLabel?: string;
  fixUrl?: string;
}

/** Map a capability report to the two display tiers (pure → unit-tested). */
export function capabilityTiers(c: Capabilities): CapTier[] {
  return [
    {
      key: "operate",
      label: "Operate",
      status: c.operate,
      detail:
        c.operate === "allowed"
          ? "Manage domains, mailboxes and sending."
          : c.operate === "denied"
            ? "Day-to-day actions will fail — the provisioning policy isn't attached."
            : "Couldn't verify this identity's permissions.",
      ...(c.operate === "denied" ? { fixLabel: "attach the provisioning policy", fixUrl: PROVISIONING_POLICY_URL } : {}),
    },
    {
      key: "deploy",
      label: "Deploy",
      status: c.deploy,
      detail:
        c.deploy === "allowed"
          ? "Can build or remove the backend."
          : c.deploy === "denied"
            ? "Can't build or tear down the backend — needed only for those one-time steps."
            : "Couldn't verify this identity's permissions.",
      ...(c.deploy === "denied" ? { fixLabel: "attach the deploy policy", fixUrl: DEPLOY_POLICY_URL } : {}),
    },
  ];
}
