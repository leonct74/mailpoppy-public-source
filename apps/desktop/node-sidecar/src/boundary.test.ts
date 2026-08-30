// The permissions-boundary precedence rule (broker-role-v2 step 2). This is the
// security-critical half of the change and the half that has no AWS in it, so it is
// tested directly: an adversarial review found a fail-open bug here precisely because
// only the template's SHAPE was covered.
// Run: node --import tsx --test src/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBoundaryValue } from "./provisioning";

const ARN = "arn:aws:iam::123456789012:policy/AgentsPoppyBoundary";
const never = async () => {
  throw new Error("readDeployed must not be called");
};

test("a host-confirmed ARN wins, without reading the stack", async () => {
  assert.equal(await resolveBoundaryValue({ confirmed: ARN, status: "UPDATE_COMPLETE", readDeployed: never }), ARN);
});

test("no confirmed ARN preserves whatever the stack already carries", async () => {
  const got = await resolveBoundaryValue({
    confirmed: undefined,
    status: "UPDATE_COMPLETE",
    readDeployed: async () => ARN,
  });
  assert.equal(got, ARN, "an absent host ARN must never STRIP an applied boundary");
});

test("no stack at all deploys unbounded", async () => {
  assert.equal(
    await resolveBoundaryValue({ confirmed: undefined, status: null, readDeployed: async () => null }),
    "",
  );
});

test("an UNREADABLE stack aborts — it must never be mistaken for 'no boundary'", async () => {
  // The fail direction that matters: a throttle or dropped connection answering "" would
  // hand CloudFormation an empty parameter and remove the ceiling from every role.
  await assert.rejects(
    () =>
      resolveBoundaryValue({
        confirmed: undefined,
        status: "UPDATE_COMPLETE",
        readDeployed: async () => {
          throw new Error("Rate exceeded");
        },
      }),
    /stopped rather than risk/i,
  );
});

test("a dead stack about to be recreated carries nothing forward", async () => {
  // Preserving a ROLLBACK_COMPLETE stack's ARN would name an UNCONFIRMED policy in a fresh
  // CreateRole — turning one boundary-caused rollback into a self-perpetuating one.
  for (const status of ["ROLLBACK_COMPLETE", "REVIEW_IN_PROGRESS"]) {
    assert.equal(await resolveBoundaryValue({ confirmed: undefined, status, readDeployed: never }), "");
  }
});

test("a confirmed ARN still applies to a stack being recreated", async () => {
  assert.equal(
    await resolveBoundaryValue({ confirmed: ARN, status: "ROLLBACK_COMPLETE", readDeployed: never }),
    ARN,
  );
});
