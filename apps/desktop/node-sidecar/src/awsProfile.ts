// In-app AWS credential entry (the "I don't want to touch a terminal" path).
//
// We persist the pasted keys as a dedicated `[mailpoppy]` profile in the standard
// `~/.aws/credentials` file (created 0600, like `aws configure`), preserving every
// other profile. The sidecar then resolves them via the SDK's `fromIni` provider
// (see `clients()`), so they survive restarts and interoperate with the AWS CLI.
// We deliberately never write `[default]`, so an existing working setup is safe.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { upsertIniSection } from "@mailpoppy/core";

/** The profile name the in-app key entry writes to (never `default`). */
export const MAILPOPPY_PROFILE = "mailpoppy";

const awsDir = (): string => join(homedir(), ".aws");
const credentialsPath = (): string => join(awsDir(), "credentials");

/** True if `~/.aws/credentials` already contains a `[mailpoppy]` profile. */
export function mailpoppyProfileExists(): boolean {
  try {
    const p = credentialsPath();
    return existsSync(p) && /^\s*\[\s*mailpoppy\s*\]\s*$/m.test(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
}

export interface AwsKeyInput {
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional — only for temporary (STS) credentials. */
  sessionToken?: string;
}

/**
 * Write/replace the `[mailpoppy]` profile in `~/.aws/credentials` with these
 * keys, leaving all other profiles untouched. Creates `~/.aws` (0700) and the
 * file (0600) if needed. Throws on empty inputs. Never logs the secret.
 */
export function writeMailpoppyProfile(input: AwsKeyInput): void {
  const accessKeyId = input.accessKeyId.trim();
  const secretAccessKey = input.secretAccessKey.trim();
  const sessionToken = input.sessionToken?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Both an Access Key ID and a Secret Access Key are required.");
  }

  const dir = awsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const p = credentialsPath();
  const existing = existsSync(p) ? readFileSync(p, "utf8") : "";
  const lines = [
    `aws_access_key_id = ${accessKeyId}`,
    `aws_secret_access_key = ${secretAccessKey}`,
    ...(sessionToken ? [`aws_session_token = ${sessionToken}`] : []),
  ];
  writeFileSync(p, upsertIniSection(existing, MAILPOPPY_PROFILE, lines), { mode: 0o600 });
}
