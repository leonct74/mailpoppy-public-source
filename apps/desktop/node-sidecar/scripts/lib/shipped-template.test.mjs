// Invariants of the template we actually SHIP — parsed out of the generated bundle, not
// out of infra/lib/mail-stack.ts. The source and the shipped artifact drift whenever
// build:bundle isn't re-run, and a stale bundle is this repo's most-repeated bug.
// Run: node --test scripts/lib/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("../../src/generated/backend-bundle.ts", import.meta.url));

/** The embedded template, as CloudFormation will see it. */
function shippedTemplate() {
  const src = readFileSync(bundlePath, "utf8");
  const m = src.match(/templateJson\s*=\s*("(?:[^"\\]|\\.)*")/s);
  assert.ok(m, "backend-bundle.ts must export templateJson — run `npm run gen:backend`");
  return JSON.parse(JSON.parse(m[1]));
}

const BOUNDARY = {
  "Fn::If": ["HasPermissionsBoundary", { Ref: "PermissionsBoundaryArn" }, { Ref: "AWS::NoValue" }],
};

test("the boundary parameter is optional, so the stack still deploys unbounded", () => {
  const tpl = shippedTemplate();
  const param = tpl.Parameters?.PermissionsBoundaryArn;
  assert.ok(param, "template must accept a PermissionsBoundaryArn parameter");
  assert.equal(param.Type, "String");
  // A non-empty default would name a policy that may not exist in the account, and IAM
  // refuses CreateRole against a missing boundary — that would break every standalone
  // install and every pre-boundary AgentsPoppy setup.
  assert.equal(param.Default, "", "default must be empty (= no boundary)");
  assert.deepEqual(tpl.Conditions?.HasPermissionsBoundary, {
    "Fn::Not": [{ "Fn::Equals": [{ Ref: "PermissionsBoundaryArn" }, ""] }],
  });
});

test("EVERY role the stack creates is capped by the boundary when one is given", () => {
  const tpl = shippedTemplate();
  const roles = Object.entries(tpl.Resources).filter(([, r]) => r.Type === "AWS::IAM::Role");
  // Most of these are CDK-implicit (Lambda execution roles, Cognito's SMS role), which is
  // exactly why this is asserted over the whole template rather than per named resource:
  // a role added later must not be able to ship unbounded unnoticed.
  assert.ok(roles.length >= 6, `expected the stack's roles, found ${roles.length}`);
  for (const [name, role] of roles) {
    assert.deepEqual(role.Properties.PermissionsBoundary, BOUNDARY, `${name} is not bounded`);
  }
});
