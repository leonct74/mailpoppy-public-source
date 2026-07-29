#!/usr/bin/env node
// Build MailPoppy's backend as the single CJS bundle AgentsPoppy's SHARED Node runtime
// executes (extension.json backend.runtime "node22" — see the agentspoppy repo's
// docs/RUNTIMES.md). This is the ONLY build path: it REPLACED the Node-SEA pipeline
// (build-sidecar.mjs, deleted in 0.1.11), which embedded a whole Node runtime and is now
// forbidden platform-wide (RUNTIMES.md R1). The package ships only MailPoppy's own code
// (incl. the embedded CDK deploy bundle) and NO copy of Node.
//
// Pipeline:
//   1. regenerate the embedded CDK backend bundle (generated/backend-bundle.ts)
//   2. esbuild src/index.ts → apps/desktop/backend/index.cjs
//   3. regenerate apps/desktop/extension.json from the TS source of truth
import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = resolve(here, ".."); // node-sidecar/
const appRoot = resolve(sidecarRoot, ".."); // apps/desktop/
const outfile = join(appRoot, "backend", "index.cjs");

function run(args) {
  execFileSync(process.execPath, args, { stdio: "inherit" });
}

// 1. Embedded one-click-deploy CDK bundle (template + Lambda zip) that provisioning.ts imports.
console.log("[1/3] regenerate embedded CDK backend bundle");
run([join(sidecarRoot, "scripts", "build-backend-bundle.mjs")]);

// 2. Bundle the sidecar (fastify, AWS SDK v3, @mailpoppy/core, the embedded bundle) into one CJS.
console.log("[2/3] esbuild bundle →", outfile);
mkdirSync(dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: [join(sidecarRoot, "src", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile,
  logLevel: "warning",
});

// 3. Regenerate extension.json from extensionManifest.ts (the single source of truth).
console.log("[3/3] regenerate extension.json");
run(["--import", "tsx", join(sidecarRoot, "scripts", "build-manifest.ts")]);

console.log(`✅ backend bundle → ${outfile} (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
