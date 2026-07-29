#!/usr/bin/env node
/**
 * Verify that THIS source reproduces a claimed backend update manifest.
 *
 * This is the Layer-2 counterpart to the "Verify with your AI agent" button: an
 * independent party (the user, or their agent) checks out the open repo at the update's
 * commit, runs `npm ci`, then runs this script to REBUILD the backend bundle from source
 * and confirm it yields the exact hashes the app is offering to deploy. A full match is a
 * cryptographic proof that the deployed backend code is that open source — no trust in the
 * publisher's build machine required. See REPRODUCE.md and agentspoppy VERIFIABLE_UPDATES.md.
 *
 * Usage (run from apps/desktop/node-sidecar, after `npm ci` at the repo root):
 *   npm run verify:backend                         # rebuild + print this build's manifest
 *   npm run verify:backend -- --expected app.json  # compare against the app's manifest (file)
 *   npm run verify:backend -- --expected -          # …read the expected manifest from stdin
 *   npm run verify:backend -- --expected '{...}'    # …or pass the JSON inline
 *
 * Exit code: 0 = reproduced (or print-only), 1 = MISMATCH / bad input.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = join(here, "..");
const genFile = join(sidecarRoot, "src", "generated", "backend-bundle.ts");

// Fields a verifier checks are byte-for-byte reproducible from source. `builtAt` is
// informational (wall clock) and `build.node` may legitimately differ (esbuild's output
// is Node-independent), so neither is part of the proof.
const PROOF_FIELDS = ["artifact", "archiveSha256"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--expected") {
      const v = argv[++i];
      // A missing/empty value must be an ERROR, not a silent downgrade to print-only mode:
      // a trust verifier that exits 0 having compared nothing is the wrong failure direction.
      if (v === undefined || v.trim() === "") {
        console.error("✖ --expected requires a value: a file path, '-' for stdin, or inline JSON.");
        process.exit(1);
      }
      out.expected = v;
    } else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
  }
  return out;
}

function loadExpected(spec) {
  let text = spec;
  if (spec === "-") text = readFileSync(0, "utf8"); // stdin
  else if (!spec.trim().startsWith("{")) text = readFileSync(spec, "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`✖ Could not parse the expected manifest as JSON: ${e.message}`);
    process.exit(1);
  }
}

/** Read the freshly-generated manifest back out of the emitted TS module. Anchored to the
 *  manifest LINE specifically (not a first-match/greedy scan of the whole file) so an earlier
 *  export whose string value happens to contain the same literal can't hijack the capture. */
function readBuiltManifest() {
  const gen = readFileSync(genFile, "utf8");
  const prefix = "export const updateManifest = ";
  const suffix = " as const;";
  const line = gen.split("\n").find((l) => l.startsWith(prefix) && l.endsWith(suffix));
  if (!line) {
    console.error("✖ Could not find updateManifest in the generated bundle — did the build run?");
    process.exit(1);
  }
  try {
    return JSON.parse(line.slice(prefix.length, line.length - suffix.length));
  } catch (e) {
    console.error(`✖ Could not parse the generated manifest as JSON: ${e.message}`);
    process.exit(1);
  }
}

function handlersMap(man) {
  return Object.fromEntries((man.handlers || []).map((h) => [h.name, h.sha256]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 22).join("\n"));
    return;
  }

  // Load the expected manifest BEFORE building, so we can pin the rebuild's archive mtime.
  const expected = args.expected ? loadExpected(args.expected) : null;

  // The archive's mtime comes from SOURCE_DATE_EPOCH. A verifier who has that var exported
  // (Nix/Guix/CI reproducible-build setups) would otherwise bake their ambient value into the
  // archive and get a spurious archiveSha256 mismatch on byte-identical source. Strip it, and
  // when we know the expected manifest, pin the rebuild to ITS recorded epoch — the correct
  // reproducible-builds semantics (SOURCE_DATE_EPOCH is the build's declared timestamp).
  const childEnv = { ...process.env };
  delete childEnv.SOURCE_DATE_EPOCH;
  if (expected?.build?.sourceDateEpoch != null) childEnv.SOURCE_DATE_EPOCH = String(expected.build.sourceDateEpoch);

  console.log("Rebuilding the backend bundle from THIS source (npm run gen:backend)…\n");
  execFileSync(process.execPath, [join(sidecarRoot, "scripts", "build-backend-bundle.mjs")], {
    stdio: "inherit",
    env: childEnv,
  });
  const built = readBuiltManifest();

  console.log("\n── This build reproduces ──────────────────────────────────────────");
  console.log(`  commit        ${built.commit}${built.dirty ? "  ⚠️  DIRTY working tree" : ""}`);
  console.log(`  artifact      ${built.artifact}`);
  console.log(`  archiveSha256 ${built.archiveSha256}`);
  for (const h of built.handlers) console.log(`  ${h.name.padEnd(20)} ${h.sha256}`);
  console.log(`  toolchain     node ${built.build?.node} · esbuild ${built.build?.esbuild} · epoch ${built.build?.sourceDateEpoch}`);

  if (!expected) {
    console.log("\nℹ️  No --expected manifest given — printed this build's hashes for you to compare");
    console.log("    against the ones the app shows. Pass --expected <file|-|json> to check automatically.");
    if (built.dirty) {
      console.log("\n⚠️  Working tree is dirty — commit or stash local changes for a clean reproduction.");
    }
    return;
  }

  const bh = handlersMap(built);
  const eh = handlersMap(expected);
  const problems = [];

  for (const f of PROOF_FIELDS) {
    if (expected[f] !== built[f]) problems.push(`${f}: expected ${expected[f]} · got ${built[f]}`);
  }
  const names = new Set([...Object.keys(bh), ...Object.keys(eh)]);
  for (const n of names) {
    if (bh[n] !== eh[n]) problems.push(`handler ${n}: expected ${eh[n] ?? "(absent)"} · got ${bh[n] ?? "(absent)"}`);
  }
  // Context (not part of the pass/fail proof, but worth flagging).
  if (expected.commit && expected.commit !== built.commit) {
    console.log(`\n⚠️  Commit differs — you are on ${built.commit}, the manifest claims ${expected.commit}.`);
    console.log("    Check out the manifest's commit for a like-for-like comparison.");
  }
  if (expected.build?.esbuild && expected.build.esbuild !== built.build?.esbuild) {
    console.log(`\n⚠️  esbuild differs — manifest built with ${expected.build.esbuild}, you have ${built.build?.esbuild}.`);
    console.log("    Run `npm ci` at the repo root to install the pinned toolchain.");
  }

  console.log("\n── Verdict ────────────────────────────────────────────────────────");
  if (problems.length === 0) {
    console.log("✅ REPRODUCED — every proof hash matches. The deployed backend code provably");
    console.log("   is this open source. (The local host binary is a separate trust root — see REPRODUCE.md.)");
    process.exit(0);
  }
  console.log("❌ MISMATCH — this source does NOT reproduce the claimed artifact:");
  for (const p of problems) console.log(`   • ${p}`);
  console.log("\n   Do NOT apply the update until this is explained. Causes: wrong commit checked out,");
  console.log("   toolchain not installed via `npm ci`, or the manifest does not match the source.");
  process.exit(1);
}

main();
