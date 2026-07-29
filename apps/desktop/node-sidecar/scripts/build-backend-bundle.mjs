#!/usr/bin/env node
/**
 * Produce the artifacts the sidecar needs to deploy the backend WITHOUT cdk at
 * runtime, and embed them in a generated TS module:
 *   1. esbuild-bundle the 4 Lambda handlers (deps inlined) → one zip (all at root)
 *   2. `cdk synth` the asset-free template
 *   3. write src/generated/backend-bundle.ts = { templateJson, lambdaZipBase64, lambdaCodeKey, updateManifest }
 *
 * The code key is content-addressed (hash of the bundled handlers) so re-deploying
 * unchanged code reuses the same S3 object. Run before bundling the sidecar binary.
 *
 * REPRODUCIBILITY (Verifiable Updates, Layer 2 — see agentspoppy docs/VERIFIABLE_UPDATES.md
 * and node-sidecar/REPRODUCE.md). Every byte this script emits is a deterministic function
 * of the source at HEAD + the pinned toolchain (npm ci), so an independent verifier can
 * rebuild from the open repo and reproduce the exact hashes in `updateManifest`:
 *   - esbuild is a PINNED, EXPLICIT devDependency (not a hoisted accident), invoked with
 *     fixed options; its output carries relative paths only (no machine paths).
 *   - the archive is written by our own deterministic ZIP writer below — sorted entries,
 *     STORED (no compression, so no zlib-version variance), fixed 0644 perms, and a fixed
 *     UTC mtime from SOURCE_DATE_EPOCH (defaults to the HEAD commit time). No system `zip`.
 *   - the only non-deterministic field is `builtAt`, which is informational and feeds NO
 *     hash a verifier checks.
 */
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicZip } from "./lib/deterministic-zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = resolve(here, "..");
const repoRoot = resolve(sidecarRoot, "..", "..", "..");
const lambdasSrc = join(repoRoot, "lambdas", "src");
const infraDir = join(repoRoot, "infra");
const buildDir = join(sidecarRoot, "build");
const outDir = join(buildDir, "lambda");
const genDir = join(sidecarRoot, "src", "generated");

// esbuild target for the Lambda handlers — recorded in the manifest so a verifier
// knows the exact bundler options to reproduce.
const ESBUILD_TARGET = "node20";
const HANDLERS = ["inbound-processor", "access-api", "janitor", "suppression"];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: repoRoot }).toString().trim();
  } catch {
    return "";
  }
};

async function main() {
  // 1. Bundle each handler into its own self-contained CJS file at the zip root.
  console.log("[1/3] esbuild Lambda handlers (esbuild", esbuild.version + ")");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: HANDLERS.map((h) => join(lambdasSrc, `${h}.ts`)),
    outdir: outDir,
    bundle: true,
    platform: "node",
    target: ESBUILD_TARGET,
    format: "cjs",
    // REPRODUCIBILITY-CRITICAL: minify. Without it, esbuild emits a module-boundary comment
    // (`// ../../../node_modules/…/foo.js`) for every bundled file, and the number of `../`
    // segments encodes WHERE each dep resolved in the install tree — which legitimately
    // differs between two valid `npm ci` layouts (hoisted vs nested) at the SAME commit. That
    // would put install-tree shape into the hashed handler bytes and cause honest verifiers to
    // diverge (a false MISMATCH). Minify strips all such comments; `legalComments:"none"` alone
    // does NOT (they aren't legal comments). Bonus: much smaller STORED archive.
    minify: true,
    legalComments: "none",
    logLevel: "warning",
  });

  // Content-addressed key (deterministic across machines for identical code) — hashed
  // over the .js bytes in a FIXED handler order, so it is independent of archive framing.
  const handlerBytes = HANDLERS.map((h) => readFileSync(join(outDir, `${h}.js`)));
  const codeHash = createHash("sha256");
  for (const b of handlerBytes) codeHash.update(b);
  const lambdaCodeKey = `lambda-code-${codeHash.digest("hex").slice(0, 16)}.zip`;

  // Reproducible archive mtime: HEAD commit time (overridable), so a rebuild at the same
  // commit yields byte-identical archives. `dirty` is flagged separately in the manifest.
  const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH || git(["log", "-1", "--format=%ct"]) || 0);

  // 2. Deterministic ZIP at the archive root (handler = "<name>.handler"). No system `zip`.
  const zipBuf = deterministicZip(
    HANDLERS.map((h, i) => ({ name: `${h}.js`, data: handlerBytes[i] })),
    sourceDateEpoch,
  );
  const zipPath = join(buildDir, lambdaCodeKey);
  rmSync(zipPath, { force: true });
  writeFileSync(zipPath, zipBuf);

  // 3. Synthesize the asset-free template.
  console.log("[2/3] cdk synth");
  execFileSync("npx", ["cdk", "synth", "--quiet"], { cwd: infraDir, stdio: "inherit" });
  const templateJson = readFileSync(join(infraDir, "cdk.out", "MailpoppyMailStack.template.json"), "utf8");

  // 4. Build the UPDATE MANIFEST — the provenance a user (or their AI agent) uses to audit
  //    what this backend update does against the open repo AND to reproduce it. Layer 1:
  //    repo/commit/summary/per-handler hashes + `dirty`. Layer 2: `archiveSha256` (the S3
  //    object) + a `build` block giving the exact toolchain & command to reproduce every
  //    hash below from source. See REPRODUCE.md.
  const normalizeRepo = (url) =>
    (url || "")
      .replace(/^git@([^:]+):/, "https://$1/")
      .replace(/^ssh:\/\/git@/, "https://")
      .replace(/\.git$/, "");
  const repo = normalizeRepo(git(["config", "--get", "remote.origin.url"]));
  const commit = git(["rev-parse", "HEAD"]);
  // The whole point of Layer 2 is provable provenance — refuse to emit a manifest that
  // claims an empty repo/commit (would ship broken compare/clone links and a manifest that
  // can't be reproduced). Build from a checkout with an `origin` remote and a HEAD commit.
  if (!repo || !commit) {
    throw new Error(
      `Refusing to build a provenance manifest without git repo/commit ` +
        `(repo=${JSON.stringify(repo)}, commit=${JSON.stringify(commit)}). ` +
        `Run from a checkout that has an 'origin' remote and a HEAD commit.`,
    );
  }
  const updateManifest = {
    poppy: "mailpoppy",
    repo,
    commit,
    dirty: git(["status", "--porcelain"]) !== "",
    builtAt: new Date().toISOString(), // informational only — feeds no verified hash
    artifact: lambdaCodeKey,
    // sha256 of the exact bytes deployed to S3 — reproducible on any runtime (STORED zip).
    archiveSha256: sha256(zipBuf),
    summary: git(["log", "-1", "--format=%s"]),
    handlers: HANDLERS.map((h, i) => ({ name: h, sha256: sha256(handlerBytes[i]) })),
    // Exactly how to reproduce every hash above from `repo@commit`.
    build: {
      node: process.version,
      esbuild: esbuild.version,
      target: ESBUILD_TARGET,
      sourceDateEpoch,
      command: "npm ci && npm run gen:backend -w @mailpoppy/desktop-sidecar",
      // The backend code is reproducible; the local host binary is not yet byte-identical.
      reproducible: true,
    },
  };

  // 5. Emit the embedded module the sidecar imports.
  console.log("[3/3] generate src/generated/backend-bundle.ts");
  mkdirSync(genDir, { recursive: true });
  const zipB64 = zipBuf.toString("base64");
  writeFileSync(
    join(genDir, "backend-bundle.ts"),
    [
      "// AUTO-GENERATED by scripts/build-backend-bundle.mjs — do not edit (git-ignored).",
      `export const lambdaCodeKey = ${JSON.stringify(lambdaCodeKey)};`,
      `export const lambdaZipBase64 = ${JSON.stringify(zipB64)};`,
      `export const templateJson = ${JSON.stringify(templateJson)};`,
      `export const updateManifest = ${JSON.stringify(updateManifest)} as const;`,
      "",
    ].join("\n"),
  );

  console.log(
    `✅ backend bundle ready (${lambdaCodeKey}, zip ${(zipBuf.length / 1024).toFixed(0)} KB, archive ${updateManifest.archiveSha256.slice(0, 12)}…)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
