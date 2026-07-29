// Desktop client for the sidecar's one-click backend deploy (CloudFormation).
// The sidecar ships the synthesized template + Lambda code, uploads them to the
// admin's account, and Create/UpdateStacks — the user never touches a terminal.
import { sidecar } from "./sidecar";

export interface DeployStarted {
  ok: true;
  stackName: string;
  operation: "CREATE" | "UPDATE" | "NO_CHANGE" | "RECREATE";
  bucket: string;
  region: string;
}

export interface DeployStatus {
  status: string; // CloudFormation StackStatus, or "NOT_FOUND"
  complete: boolean;
  failed: boolean;
  reason?: string;
  outputs?: Record<string, string>;
  /** The stack's ARN — lets the wizard distinguish a freshly-created stack from a
   *  leftover one with the same name (a prior failed deploy being replaced). */
  stackId?: string;
}

export function deployBackend(input: {
  domain: string;
  stackName?: string;
  enableMalwareProtection?: boolean;
  enableEncryption?: boolean;
}): Promise<DeployStarted> {
  return sidecar("/deploy/backend", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deployStatus(stackName: string): Promise<DeployStatus> {
  return sidecar(`/deploy/backend/${encodeURIComponent(stackName)}/status`);
}

/** Reproducibility provenance (Verifiable Updates, Layer 2): exactly how to rebuild this
 *  bundle from source and recompute its hashes. See docs/VERIFIABLE_UPDATES.md §5. */
export interface UpdateBuildInfo {
  /** Node version the manifest was built with (informational; esbuild output is Node-independent). */
  node: string;
  /** Pinned esbuild version — a verifier must use the same (npm ci installs it). */
  esbuild: string;
  /** esbuild `target` for the Lambda handlers. */
  target: string;
  /** Fixed archive mtime (defaults to the HEAD commit time) — makes the zip byte-reproducible. */
  sourceDateEpoch: number;
  /** The exact command that reproduces every hash in the manifest from `repo@commit`. */
  command: string;
  /** True once the backend build is reproducible (the local host binary is a separate trust root). */
  reproducible: boolean;
}

/** Provenance for the backend code in an app build — what an update would ship, for the
 *  user (or their AI agent) to audit against the open repo AND reproduce from source.
 *  See docs/VERIFIABLE_UPDATES.md. */
export interface UpdateManifest {
  poppy: string;
  /** Open repository URL (https). */
  repo: string;
  /** Source commit this build came from. */
  commit: string;
  /** True if the build's working tree had uncommitted changes (may not match the commit). */
  dirty: boolean;
  builtAt: string;
  /** Content-addressed artifact key (the deployed Lambda bundle). */
  artifact: string;
  /** sha256 of the exact deterministic zip deployed to S3 — reproducible on any runtime. */
  archiveSha256: string;
  /** Human summary (the source commit's subject). */
  summary: string;
  handlers: { name: string; sha256: string }[];
  /** How to reproduce the hashes above from source (Layer 2). */
  build: UpdateBuildInfo;
}

export interface BackendVersion {
  stackExists: boolean;
  /** LambdaCodeKey currently deployed on the stack. */
  deployedKey?: string;
  /** The code key bundled in THIS app build. */
  currentKey: string;
  updateAvailable: boolean;
  /** CloudFormation StackStatus — non-`*_COMPLETE` means an operation is in flight. */
  stackStatus?: string;
  /** Open-repo commit currently deployed (absent on pre-provenance backends). */
  deployedCommit?: string;
  /** Provenance manifest for the code THIS build would deploy. */
  manifest: UpdateManifest;
  stackName: string;
  region: string;
}

/** Is this app build carrying newer backend code than what's deployed? (read-only) */
export function backendVersion(): Promise<BackendVersion> {
  return sidecar("/deploy/backend/version");
}

/** Update the deployed backend to this build's Lambda code — code only, every other
 *  setting preserved. Returns immediately; poll deployStatus for completion. */
export function updateBackendCode(): Promise<DeployStarted> {
  return sidecar("/deploy/backend/update", { method: "POST" });
}
