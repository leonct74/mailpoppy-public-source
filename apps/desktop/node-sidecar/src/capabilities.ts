// Live AWS capability check for the "permissions lights" in the UI.
//
// We can't read the identity's attached policy *names* (it usually lacks iam:Get*
// on itself, may be a role/SSO, and the policy could be renamed). Instead we ask
// AWS the real question — "can this principal perform action X?" — via
// iam:SimulatePrincipalPolicy, which evaluates the *effective* permissions
// (managed + inline + boundaries + SCPs) WITHOUT executing anything.
//
// Each tier is probed with actions that live in exactly one of the two shipped
// policies, so an "allowed" cleanly attributes the capability:
//   • operate → route53/ses actions (provisioning policy only)
//   • deploy  → iam:CreateRole / lambda:CreateFunction / cognito CreateUserPool
//               (deploy policy only)

import { fromIni } from "@aws-sdk/credential-providers";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { IAMClient, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import type { AwsContext } from "./provisioning";

export type CapStatus = "allowed" | "denied" | "unknown";

export interface CapabilityReport {
  operate: CapStatus;
  deploy: CapStatus;
  /** false when the identity can't even run the simulation (lacks iam:SimulatePrincipalPolicy). */
  checkable: boolean;
  /** false when no usable AWS credentials resolved yet (nothing connected). Not an error. */
  connected: boolean;
  /** the principal we evaluated, for display. */
  arn?: string;
}

interface Probe {
  action: string;
  resource?: string;
}

const OPERATE_PROBES: Probe[] = [{ action: "route53:ChangeResourceRecordSets" }, { action: "ses:CreateEmailIdentity" }];
const deployProbes = (account: string): Probe[] => [
  { action: "iam:CreateRole", resource: `arn:aws:iam::${account}:role/MailpoppyMailStack-probe` },
  { action: "lambda:CreateFunction", resource: `arn:aws:lambda:*:${account}:function:MailpoppyMailStack-probe` },
  { action: "cognito-idp:CreateUserPool" },
];

/**
 * SimulatePrincipalPolicy needs the *IAM* user/role ARN. An assumed-role session
 * ARN (`…:assumed-role/Role/session`) must be rewritten to the role ARN; IAM user
 * ARNs pass through unchanged.
 */
export function policySourceArn(arn: string): string {
  const m = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(arn);
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}

class SimulateUnavailable extends Error {}

export async function checkCapabilities(ctx: AwsContext): Promise<CapabilityReport> {
  const credentials = ctx.profile ? fromIni({ profile: ctx.profile, ignoreCache: true }) : undefined;
  const sts = new STSClient({ region: ctx.region, credentials });

  let arn = "";
  let account = "";
  try {
    const id = await sts.send(new GetCallerIdentityCommand({}));
    arn = id.Arn ?? "";
    account = id.Account ?? "";
  } catch {
    // No usable credentials resolved (no profile yet, or expired/invalid keys).
    // This is the normal state before onboarding — the lights show "not
    // connected" rather than an alarming error in the always-visible sidebar.
    return { operate: "unknown", deploy: "unknown", checkable: false, connected: false };
  }

  const source = policySourceArn(arn);
  const iam = new IAMClient({ region: ctx.region, credentials });

  async function simulate(p: Probe): Promise<boolean> {
    try {
      const out = await iam.send(
        new SimulatePrincipalPolicyCommand({
          PolicySourceArn: source,
          ActionNames: [p.action],
          ...(p.resource ? { ResourceArns: [p.resource] } : {}),
        }),
      );
      return out.EvaluationResults?.[0]?.EvalDecision === "allowed";
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      // Can't simulate at all (no permission, or principal isn't simulatable, e.g. root).
      if (/AccessDenied|NoSuchEntity|InvalidInput|ValidationError/i.test(name)) throw new SimulateUnavailable();
      throw e;
    }
  }

  async function tier(probes: Probe[]): Promise<CapStatus> {
    const results = await Promise.all(probes.map(simulate));
    return results.every(Boolean) ? "allowed" : "denied";
  }

  try {
    const [operate, deploy] = await Promise.all([tier(OPERATE_PROBES), tier(deployProbes(account))]);
    return { operate, deploy, checkable: true, connected: true, arn };
  } catch (e) {
    if (e instanceof SimulateUnavailable)
      return { operate: "unknown", deploy: "unknown", checkable: false, connected: true, arn };
    throw e;
  }
}
