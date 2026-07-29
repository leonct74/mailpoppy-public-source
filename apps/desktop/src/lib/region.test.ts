import { describe, it, expect } from "vitest";
import { startupRegion } from "./region";

const AVAILABLE = ["eu-west-1", "us-east-1", "us-west-2"];

describe("startupRegion", () => {
  it("prefers the connected deployment's region over the saved pick", () => {
    expect(
      startupRegion({ deploymentRegion: "eu-west-1", saved: "us-east-1", current: "us-east-1", available: AVAILABLE }),
    ).toBe("eu-west-1");
  });

  it("falls back to the saved pick when there's no deployment region", () => {
    expect(
      startupRegion({ deploymentRegion: null, saved: "eu-west-1", current: "us-east-1", available: AVAILABLE }),
    ).toBe("eu-west-1");
  });

  it("returns null when the wanted region already matches the sidecar (no-op)", () => {
    expect(
      startupRegion({ deploymentRegion: "eu-west-1", saved: null, current: "eu-west-1", available: AVAILABLE }),
    ).toBeNull();
  });

  it("returns null when the wanted region isn't available (never POST an unsupported region)", () => {
    expect(
      startupRegion({ deploymentRegion: "ap-south-1", saved: null, current: "us-east-1", available: AVAILABLE }),
    ).toBeNull();
  });

  it("returns null when nothing is persisted", () => {
    expect(
      startupRegion({ deploymentRegion: null, saved: null, current: "us-east-1", available: AVAILABLE }),
    ).toBeNull();
  });
});
