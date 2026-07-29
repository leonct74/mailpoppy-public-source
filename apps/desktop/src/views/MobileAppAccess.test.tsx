import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileAppAccess } from "./MobileAppAccess";
import type { HubDomainStatus } from "../lib/hubAccount";

// Mock the two lib modules the panel talks to.
const isDomainPurchased = vi.fn();
const startDomainCheckout = vi.fn();
vi.mock("../lib/commerce", () => ({
  isDomainPurchased: (d: string) => isDomainPurchased(d),
  startDomainCheckout: (d: string) => startDomainCheckout(d),
  openBillingPortal: vi.fn(async () => ({ ok: true, url: "", opened: true })),
}));

const mobileAppsLive = vi.fn();
const notifyMobileInterest = vi.fn();
const checkHubDomain = vi.fn();
vi.mock("../lib/hubAccount", () => ({
  activationUrl: () => "https://mailpoppy.com/activate",
  checkHubDomain: (d: string) => checkHubDomain(d),
  mobileAppsLive: () => mobileAppsLive(),
  notifyMobileInterest: (e: string, d: string) => notifyMobileInterest(e, d),
}));

const deployment = { region: "eu-west-1", userPoolId: "p", clientId: "c", apiBaseUrl: "https://api" };

beforeEach(() => {
  isDomainPurchased.mockReset().mockResolvedValue(false);
  startDomainCheckout.mockReset().mockResolvedValue({ ok: true, url: "https://pay", opened: true });
  mobileAppsLive.mockReset().mockResolvedValue(false);
  notifyMobileInterest.mockReset().mockResolvedValue(true);
  checkHubDomain.mockReset().mockResolvedValue("unregistered" as HubDomainStatus);
});
afterEach(() => cleanup());

describe("MobileAppAccess — coming-soon gate", () => {
  it("when the apps are NOT live, shows coming soon + notify me and NO purchase button", async () => {
    mobileAppsLive.mockResolvedValue(false);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    // The load-bearing guarantee: no way to pay while there's nothing to download.
    expect(screen.queryByRole("button", { name: /Set up mobile access/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Notify me/i })).toBeInTheDocument();
    expect(startDomainCheckout).not.toHaveBeenCalled();
  });

  it("captures an interested email through notifyMobileInterest and thanks the user", async () => {
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);
    await screen.findByText(/coming soon/i);

    const notify = screen.getByRole("button", { name: /Notify me/i });
    // Disabled until a plausible email is entered.
    expect(notify).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/you@example.com/i), { target: { value: "me@acme.io" } });
    expect(notify).toBeEnabled();
    fireEvent.click(notify);

    await waitFor(() => expect(notifyMobileInterest).toHaveBeenCalledWith("me@acme.io", "ollydigital.com"));
    expect(await screen.findByText(/we’ll email you when the mobile app is available/i)).toBeInTheDocument();
  });

  it("when the apps ARE live, shows the purchase button (and no notify capture)", async () => {
    mobileAppsLive.mockResolvedValue(true);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByRole("button", { name: /Set up mobile access/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notify me/i })).toBeNull();
  });

  it("defaults to coming-soon (no buy button) if the live check fails", async () => {
    mobileAppsLive.mockRejectedValue(new Error("network"));
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up mobile access/i })).toBeNull();
  });
});
