#!/usr/bin/env tsx
/**
 * Generate apps/desktop/extension.json — MailPoppy's AgentsPoppy extension manifest
 * — from its real declared scope (agentspoppyBroker.permissionSet()), so the JSON
 * the container host reads can never drift from the TS source of truth.
 *
 * Run from the node-sidecar workspace:  tsx scripts/build-manifest.ts
 * (also runs automatically as part of `npm run build:bundle`).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildExtensionManifest, type Capability } from "../src/extensionManifest";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, "..", "..", "extension.json"); // apps/desktop/extension.json

const KNOWN_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "aws:credentials",
  "connection:read",
  "backend:invoke",
  "host:openExternal",
  "host:notify",
]);
// Same rules @agentspoppy/extension-sdk's validateManifest applies — checked here so a
// bad manifest fails MailPoppy's build, not only the host load.
const ID_RE = /^[a-z0-9]+([.-][a-z0-9]+)+$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

const m = buildExtensionManifest();
const problems: string[] = [];
if (!ID_RE.test(m.id)) problems.push(`id "${m.id}" is not reverse-DNS`);
if (!SEMVER_RE.test(m.version)) problems.push(`version "${m.version}" is not semver`);
if (!m.frontend.entry.trim()) problems.push("frontend.entry is empty");
if (m.backend && !m.backend.entry.trim()) problems.push("backend.entry is empty");
if (!m.capabilities.length) problems.push("capabilities is empty");
for (const c of m.capabilities) if (!KNOWN_CAPABILITIES.has(c)) problems.push(`unknown capability "${c}"`);
const ps = m.permissionSet;
if (!ps?.id?.trim()) problems.push("permissionSet.id is empty");
if (!Array.isArray(ps?.requiredTags)) problems.push("permissionSet.requiredTags must be an array");
if (!Array.isArray(ps?.grants) || ps.grants.length === 0) problems.push("permissionSet.grants must be non-empty");
ps?.grants?.forEach((g, i) => {
  if (!g.service?.trim()) problems.push(`grants[${i}].service is empty`);
  if (!Array.isArray(g.actions) || g.actions.length === 0) problems.push(`grants[${i}].actions must be non-empty`);
  if (!g.resourceScope?.trim()) problems.push(`grants[${i}].resourceScope is empty`);
});
if (problems.length) {
  console.error("extension.json is invalid:\n- " + problems.join("\n- "));
  process.exit(1);
}

writeFileSync(outPath, JSON.stringify(m, null, 2) + "\n", "utf8");
console.log(`wrote ${outPath} (${m.permissionSet.grants.length} grants, ${m.capabilities.length} capabilities)`);
