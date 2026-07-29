import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the sidecar transport and the region setters so we can assert what
// autoDiscoverRegion decides without any real HTTP or localStorage.
const { sidecarMock, setRegionMock, persistRegionMock } = vi.hoisted(() => ({
  sidecarMock: vi.fn(),
  setRegionMock: vi.fn(),
  persistRegionMock: vi.fn(),
}));
vi.mock("./sidecar", () => ({ sidecar: sidecarMock }));
vi.mock("./region", () => ({ setRegion: setRegionMock, persistRegion: persistRegionMock }));

import { autoDiscoverRegion } from "./discovery";

beforeEach(() => {
  sidecarMock.mockReset();
  setRegionMock.mockReset().mockImplementation(async (r: string) => ({ ok: true, region: r }));
  persistRegionMock.mockReset();
});

describe("autoDiscoverRegion", () => {
  it("snaps to the region holding the backend stack and persists it", async () => {
    sidecarMock.mockResolvedValue({
      currentRegion: "eu-west-1",
      stackRegion: "us-east-1",
      domainRegion: null,
      regions: [],
    });
    expect(await autoDiscoverRegion()).toBe("us-east-1");
    expect(setRegionMock).toHaveBeenCalledWith("us-east-1");
    expect(persistRegionMock).toHaveBeenCalledWith("us-east-1");
  });

  it("falls back to the sole region with SES domains when there's no stack", async () => {
    sidecarMock.mockResolvedValue({
      currentRegion: "eu-west-1",
      stackRegion: null,
      domainRegion: "us-west-2",
      regions: [],
    });
    expect(await autoDiscoverRegion()).toBe("us-west-2");
    expect(setRegionMock).toHaveBeenCalledWith("us-west-2");
  });

  it("prefers the stack region over a domains-only region", async () => {
    sidecarMock.mockResolvedValue({
      currentRegion: "eu-west-1",
      stackRegion: "us-east-1",
      domainRegion: "us-west-2",
      regions: [],
    });
    expect(await autoDiscoverRegion()).toBe("us-east-1");
  });

  it("is a no-op when the target region already matches the sidecar", async () => {
    sidecarMock.mockResolvedValue({
      currentRegion: "us-east-1",
      stackRegion: "us-east-1",
      domainRegion: null,
      regions: [],
    });
    expect(await autoDiscoverRegion()).toBeNull();
    expect(setRegionMock).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is found anywhere", async () => {
    sidecarMock.mockResolvedValue({
      currentRegion: "eu-west-1",
      stackRegion: null,
      domainRegion: null,
      regions: [],
    });
    expect(await autoDiscoverRegion()).toBeNull();
    expect(setRegionMock).not.toHaveBeenCalled();
  });

  it("never throws — a failed probe (offline / no creds) returns null", async () => {
    sidecarMock.mockRejectedValue(new Error("Couldn't reach AWS"));
    expect(await autoDiscoverRegion()).toBeNull();
    expect(setRegionMock).not.toHaveBeenCalled();
  });
});
