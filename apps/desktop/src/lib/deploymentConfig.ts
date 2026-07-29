// The values the desktop app needs to talk to a deployed MailPoppy backend.
// They are CloudFormation stack Outputs (see infra/lib/mail-stack.ts):
//   ApiBaseUrl, UserPoolId, UserPoolClientId, DeployRegion.
// Persisted locally so the admin enters them once.

export interface DeploymentConfig {
  apiBaseUrl: string;
  userPoolId: string;
  clientId: string;
  region: string;
  /** CloudFormation stack name this backend was deployed under. Optional for
   *  backward-compat with installs deployed before we persisted it. */
  stackName?: string;
}

// There is exactly one backend per install and the deploy flow always creates
// it under this name, so it's a constant — never something the admin types.
// Kept as a single export so every screen resolves the same value.
export const DEFAULT_STACK_NAME = "MailpoppyMailStack";

const KEY = "mailpoppy.deployment";

export function loadDeploymentConfig(): DeploymentConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<DeploymentConfig>;
    if (c.apiBaseUrl && c.userPoolId && c.clientId && c.region) {
      return {
        apiBaseUrl: c.apiBaseUrl,
        userPoolId: c.userPoolId,
        clientId: c.clientId,
        region: c.region,
        ...(c.stackName ? { stackName: c.stackName } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveDeploymentConfig(c: DeploymentConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function clearDeploymentConfig(): void {
  localStorage.removeItem(KEY);
}

/**
 * The stack name every screen should use. Reads the name persisted at deploy
 * time, falling back to the default for installs that predate persistence (or
 * before the backend is deployed). This replaces the old editable "Stack name"
 * inputs: there's only ever one backend, so the name is resolved, not typed.
 */
export function resolveStackName(): string {
  return loadDeploymentConfig()?.stackName ?? DEFAULT_STACK_NAME;
}
