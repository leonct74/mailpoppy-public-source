import { sidecar } from "./sidecar";

// The environment-readiness shape the sidecar's GET /aws/readiness returns (and
// POST /aws/credentials echoes back after saving). Shared so the wizard and the
// onboarding panel agree on the type.
export interface Readiness {
  cli: { installed: boolean; version?: string };
  credentials: { ok: boolean; arn?: string; account?: string; error?: string };
  permissions: Record<"route53" | "ses" | "sesv2" | "s3", "ok" | "denied" | "error">;
  ready: boolean;
}

export interface AwsCredentialInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** Only for temporary (STS) credentials — usually left blank. */
  sessionToken?: string;
}

/**
 * Hand pasted AWS keys to the sidecar, which persists them as a local
 * `[mailpoppy]` profile (standard `~/.aws/credentials`, 0600, other profiles
 * untouched) and switches to using them. Returns a fresh readiness so the caller
 * can tell immediately whether the keys actually work.
 */
export function setAwsCredentials(input: AwsCredentialInput): Promise<Readiness> {
  return sidecar<Readiness>("/aws/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
