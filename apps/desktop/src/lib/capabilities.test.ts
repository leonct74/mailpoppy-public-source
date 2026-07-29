import { describe, it, expect } from "vitest";
import { capabilityTiers, type Capabilities } from "./capabilities";

/** capabilityTiers always returns [operate, deploy]; index safely under noUncheckedIndexedAccess. */
function tiers(c: Capabilities) {
  const [operate, deploy] = capabilityTiers(c);
  if (!operate || !deploy) throw new Error("expected two tiers");
  return { operate, deploy };
}

describe("capabilityTiers", () => {
  it("both allowed → green, no fix links", () => {
    const { operate, deploy } = tiers({ operate: "allowed", deploy: "allowed", checkable: true, connected: true });
    expect(operate.status).toBe("allowed");
    expect(deploy.status).toBe("allowed");
    expect(operate.fixUrl).toBeUndefined();
    expect(deploy.fixUrl).toBeUndefined();
  });

  it("denied deploy → points at the deploy policy", () => {
    const { deploy } = tiers({ operate: "allowed", deploy: "denied", checkable: true, connected: true });
    expect(deploy.status).toBe("denied");
    expect(deploy.fixLabel).toMatch(/deploy policy/i);
    expect(deploy.fixUrl).toMatch(/mailpoppy-deploy-policy\.json$/);
    expect(deploy.detail).toMatch(/can't build or tear down/i);
  });

  it("denied operate → points at the provisioning policy", () => {
    const { operate } = tiers({ operate: "denied", deploy: "allowed", checkable: true, connected: true });
    expect(operate.fixLabel).toMatch(/provisioning policy/i);
    expect(operate.fixUrl).toMatch(/mailpoppy-provisioning-policy\.json$/);
  });

  it("unknown → no fix link (we don't know what's missing)", () => {
    const { operate, deploy } = tiers({ operate: "unknown", deploy: "unknown", checkable: false, connected: true });
    expect(operate.fixUrl).toBeUndefined();
    expect(deploy.fixUrl).toBeUndefined();
    expect(operate.detail).toMatch(/couldn't verify/i);
  });
});
