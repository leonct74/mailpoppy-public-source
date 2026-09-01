// Guards on the permission set MailPoppy publishes — the two things a reader of the
// AgentsPoppy permissions screen is actually shown. Both had already drifted from reality
// once: MailPoppy declared ONE attribution tag while stamping three (which cost it the only
// "missing attribution tags" warning in the fleet), and the grant list carried two
// `apigateway` actions that do not exist in IAM at all.
// Run: node --import tsx --test src/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionSet, ACCOUNT_TAG_KEY, APP_TAG_KEY, CONNECTION_TAG_KEY } from "./agentspoppyBroker";

test("declares every attribution tag it actually stamps, so AgentsPoppy can attribute and tear down", () => {
  // brokerStackTags() puts all three on the stack; declaring fewer understates what we do
  // and trips the assessor's attribution warning.
  const declared = permissionSet().requiredTags;
  for (const key of [ACCOUNT_TAG_KEY, APP_TAG_KEY, CONNECTION_TAG_KEY]) {
    assert.ok(declared.includes(key), `requiredTags is missing ${key}`);
  }
});

test("declares no action that IAM does not define", () => {
  // API Gateway tags through PUT/POST/DELETE on the /tags path — there is no
  // apigateway:TagResource action, and Access Analyzer rejects it as INVALID_ACTION.
  const declared = permissionSet().grants.flatMap((g) => g.actions.map((a) => `${g.service}:${a}`));
  for (const dead of ["apigateway:TagResource", "apigateway:UntagResource"]) {
    assert.ok(!declared.includes(dead), `${dead} is not a real IAM action`);
  }
});

test("keeps the boundary actions on the stack's own role scope, never account-wide", () => {
  const boundary = permissionSet().grants.filter((g) =>
    g.actions.some((a) => a.endsWith("RolePermissionsBoundary")),
  );
  assert.ok(boundary.length > 0, "the boundary actions are not declared at all");
  for (const g of boundary) {
    assert.equal(g.resourceScope, "arn:aws:iam::*:role/MailpoppyMailStack-*");
  }
});
