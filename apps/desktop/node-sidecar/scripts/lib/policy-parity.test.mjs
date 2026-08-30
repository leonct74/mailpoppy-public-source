/**
 * The two shipped deploy policies must stay identical.
 *
 * `infra/policies/mailpoppy-deploy-policy.json` is the raw IAM policy an admin can paste;
 * `mailpoppy-deploy-role.yaml` ships THE SAME policy as a CloudFormation service role, and
 * its README promises the two grant the same thing. Nothing enforced that, and they drifted
 * three separate times — most recently when `apigateway` gained the `/v2/apis*` + `/tags*`
 * paths (commit 79861be, whose whole point was "so the deploy stops rolling back"): the JSON
 * was fixed and the YAML was not, so an admin on the DOCUMENTED least-privilege path kept
 * hitting the exact rollback that commit fixed, while the JSON looked correct to everyone
 * reviewing it. A drift here is invisible until a real deploy fails asynchronously.
 *
 * The YAML carries two policy documents: the service role's (deeper-indented) and the admin
 * caller's `cloudformation:* + iam:PassRole` policy. Only the first is the JSON's twin, so we
 * locate it by an anchor Sid. (The admin document may legitimately repeat a Sid — `CapabilityCheck`
 * appears in both — since Sids need only be unique within one document.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const policies = resolve(here, "..", "..", "..", "..", "..", "infra", "policies");

const json = JSON.parse(readFileSync(join(policies, "mailpoppy-deploy-policy.json"), "utf8"));
const yamlText = readFileSync(join(policies, "mailpoppy-deploy-role.yaml"), "utf8");

const unquote = (s) => s.trim().replace(/^["']|["']$/g, "");
/** Accept both YAML block sequences and inline `[a, b]` flow sequences. */
const values = (raw) => {
  const s = raw.trim();
  if (!s.startsWith("[")) return [unquote(s)];
  return s
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map(unquote)
    .filter(Boolean);
};

/** Parse every `- Sid:` statement out of the YAML, tagged with the indent it sits at. */
function parseYamlStatements(text) {
  const out = [];
  let cur = null;
  let key = null;
  for (const line of text.split("\n")) {
    const sid = line.match(/^(\s*)-\s*Sid:\s*(\S+)/);
    if (sid) {
      if (cur) out.push(cur);
      cur = { indent: sid[1].length, Sid: sid[2], Action: [], Resource: [] };
      key = null;
      continue;
    }
    if (!cur) continue;
    const block = line.match(/^\s*(Action|Resource):\s*$/);
    if (block) {
      key = block[1];
      continue;
    }
    const inline = line.match(/^\s*(Action|Resource):\s*(\S.*)$/);
    if (inline) {
      cur[inline[1]].push(...values(inline[2]));
      key = null;
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      cur[key].push(...values(item[1]));
      continue;
    }
    if (/^\s*[A-Za-z]+:/.test(line)) key = null;
  }
  if (cur) out.push(cur);
  return out;
}

const sorted = (v) => [...new Set(Array.isArray(v) ? v : [v])].sort();
const anchor = json.Statement[0].Sid;

const parsed = parseYamlStatements(yamlText);
const anchored = parsed.find((s) => s.Sid === anchor);

test("the YAML actually parsed — a silent parse failure must not pass vacuously", () => {
  assert.ok(anchored, `anchor Sid ${anchor} not found in the YAML — the parser or the file changed shape`);
  assert.ok(json.Statement.length > 10, "the JSON policy looks truncated");
});

const serviceRole = parsed.filter((s) => s.indent === anchored.indent);

test("the service role grants exactly the JSON policy's statements", () => {
  assert.deepEqual(
    serviceRole.map((s) => s.Sid).sort(),
    json.Statement.map((s) => s.Sid).sort(),
    "Sid sets differ between mailpoppy-deploy-policy.json and the service role in mailpoppy-deploy-role.yaml",
  );
});

test("every statement grants the same actions on the same resources in both files", () => {
  const byYamlSid = new Map(serviceRole.map((s) => [s.Sid, s]));
  for (const stmt of json.Statement) {
    const twin = byYamlSid.get(stmt.Sid);
    assert.ok(twin, `${stmt.Sid} missing from the YAML service role`);
    assert.deepEqual(sorted(twin.Action), sorted(stmt.Action), `${stmt.Sid}: action set differs`);
    assert.deepEqual(sorted(twin.Resource), sorted(stmt.Resource), `${stmt.Sid}: resource set differs`);
  }
});
