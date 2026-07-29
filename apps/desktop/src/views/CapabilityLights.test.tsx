import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { CapabilityLights } from "./CapabilityLights";
import { sidecar } from "../lib/sidecar";

vi.mock("../lib/sidecar", () => ({ sidecar: vi.fn() }));
const mockSidecar = vi.mocked(sidecar);

const writeText = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  mockSidecar.mockReset();
  writeText.mockClear();
});

describe("CapabilityLights", () => {
  it("shows both tiers green when the identity can operate and deploy", async () => {
    mockSidecar.mockResolvedValue({ operate: "allowed", deploy: "allowed", checkable: true, connected: true });
    render(<CapabilityLights />);
    expect(await screen.findByText(/Manage domains, mailboxes and sending/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Operate: ok/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Deploy: ok/i })).toBeInTheDocument();
  });

  it("flags missing deploy permission and links the deploy policy", async () => {
    mockSidecar.mockResolvedValue({ operate: "allowed", deploy: "denied", checkable: true, connected: true });
    render(<CapabilityLights />);
    expect(await screen.findByRole("img", { name: /Deploy: missing/i })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /attach the deploy policy/i });
    expect(link).toHaveAttribute("href", expect.stringMatching(/mailpoppy-deploy-policy\.json$/));
  });

  it("degrades to an amber 'enable the live check' hint when not checkable", async () => {
    mockSidecar.mockResolvedValue({ operate: "unknown", deploy: "unknown", checkable: false, connected: true });
    render(<CapabilityLights />);
    expect(await screen.findByText(/iam:SimulatePrincipalPolicy/i)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Operate: unknown/i })).toBeInTheDocument();
  });

  it("shows a quiet 'connect your AWS account' note when nothing is connected yet", async () => {
    mockSidecar.mockResolvedValue({ operate: "unknown", deploy: "unknown", checkable: false, connected: false });
    render(<CapabilityLights />);
    expect(await screen.findByText(/Connect your AWS account/i)).toBeInTheDocument();
    // No lights and no scary error in the not-connected state.
    expect(screen.queryByRole("img", { name: /Operate:/i })).not.toBeInTheDocument();
  });

  it("offers copy-to-clipboard buttons for both policies, even when nothing is connected", async () => {
    mockSidecar.mockResolvedValue({ operate: "unknown", deploy: "unknown", checkable: false, connected: false });
    render(<CapabilityLights />);
    const provBtn = await screen.findByRole("button", { name: /Copy provisioning policy/i });
    expect(screen.getByRole("button", { name: /Copy deploy policy/i })).toBeInTheDocument();

    fireEvent.click(provBtn);
    expect(writeText).toHaveBeenCalledTimes(1);
    const arg = writeText.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    // What we copy is a real, paste-ready IAM policy document.
    const doc = JSON.parse(arg as string) as { Statement?: unknown };
    expect(Array.isArray(doc.Statement)).toBe(true);

    // Button gives copied feedback.
    expect(await screen.findByRole("button", { name: /Copied!/i })).toBeInTheDocument();
  });
});
