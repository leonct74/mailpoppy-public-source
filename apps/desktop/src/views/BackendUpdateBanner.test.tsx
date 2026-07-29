import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BackendUpdateBanner } from "./BackendUpdateBanner";
import type { BackendVersion } from "../lib/deploy";

const version: BackendVersion = {
  stackExists: true,
  deployedKey: "lambda-code-old.zip",
  currentKey: "lambda-code-new.zip",
  updateAvailable: true,
  stackStatus: "CREATE_COMPLETE",
  deployedCommit: "aaa",
  manifest: {
    poppy: "mailpoppy",
    repo: "https://github.com/leonct74/mailpoppy",
    commit: "bbb",
    dirty: false,
    builtAt: "2026-07-07T00:00:00Z",
    artifact: "lambda-code-new.zip",
    archiveSha256: "deadbeef",
    summary: "improved spam handling",
    handlers: [],
    build: {
      node: "v22",
      esbuild: "0.28.0",
      target: "node20",
      sourceDateEpoch: 1,
      command: "npm ci && …",
      reproducible: true,
    },
  },
  stackName: "mailpoppy-mail",
  region: "eu-west-1",
};

const backendVersion = vi.fn();
vi.mock("../lib/deploy", () => ({
  backendVersion: () => backendVersion(),
}));

beforeEach(() => {
  backendVersion.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

describe("BackendUpdateBanner", () => {
  it("announces an available update and routes Review to the Account view", async () => {
    backendVersion.mockResolvedValue(version);
    const onReview = vi.fn();
    render(<BackendUpdateBanner onReview={onReview} />);

    await waitFor(() => expect(screen.getByText(/backend update/i)).toBeTruthy());
    expect(screen.getByText(/improved spam handling/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /review the update/i }));
    expect(onReview).toHaveBeenCalled();
  });

  it("mute needs the checkbox first, is per-update, and a NEW update notifies again", async () => {
    backendVersion.mockResolvedValue(version);
    const { unmount } = render(<BackendUpdateBanner onReview={() => {}} />);
    await waitFor(() => expect(screen.getByText(/backend update/i)).toBeTruthy());

    // Button is disabled until the "I've reviewed it" checkbox is ticked.
    const mute = screen.getByRole("button", { name: /don't show again/i }) as HTMLButtonElement;
    expect(mute.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(mute.disabled).toBe(false);

    fireEvent.click(mute);
    expect(screen.queryByText(/backend update/i)).toBeNull();
    unmount();

    // Same update again → stays muted.
    const second = render(<BackendUpdateBanner onReview={() => {}} />);
    await waitFor(() => expect(backendVersion).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/backend update/i)).toBeNull();
    second.unmount();

    // A NEWER update (different code key) → banner returns.
    backendVersion.mockResolvedValue({ ...version, currentKey: "lambda-code-newer.zip" });
    render(<BackendUpdateBanner onReview={() => {}} />);
    await waitFor(() => expect(screen.getByText(/backend update/i)).toBeTruthy());
  });

  it("renders nothing when up to date, hidden, or the check fails", async () => {
    backendVersion.mockResolvedValue({ ...version, updateAvailable: false });
    const upToDate = render(<BackendUpdateBanner onReview={() => {}} />);
    await waitFor(() => expect(backendVersion).toHaveBeenCalled());
    expect(screen.queryByText(/backend update/i)).toBeNull();
    upToDate.unmount();

    backendVersion.mockResolvedValue(version);
    const hidden = render(<BackendUpdateBanner hidden onReview={() => {}} />);
    expect(screen.queryByText(/backend update/i)).toBeNull();
    hidden.unmount();

    backendVersion.mockRejectedValue(new Error("sidecar down"));
    render(<BackendUpdateBanner onReview={() => {}} />);
    await waitFor(() => expect(backendVersion).toHaveBeenCalled());
    expect(screen.queryByText(/backend update/i)).toBeNull();
  });
});
