import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MobileAppAccess } from "./MobileAppAccess";
import type { HubDomainStatus } from "../lib/hubAccount";

// Mock the two lib modules the panel talks to.
const getDomainStanding = vi.fn();
const getTrialDays = vi.fn();
const startDomainCheckout = vi.fn();
vi.mock("../lib/commerce", async (orig) => ({
  // Keep the REAL pure helpers (daysLeft/trialCountdownLabel) so the countdown the test asserts is
  // the one users see, not a stub.
  ...(await orig<typeof import("../lib/commerce")>()),
  getDomainStanding: (d: string) => getDomainStanding(d),
  getTrialDays: () => getTrialDays(),
  startDomainCheckout: (d: string) => startDomainCheckout(d),
  openBillingPortal: vi.fn(async () => ({ ok: true, url: "", opened: true })),
}));

const ENTITLED = { entitled: true, status: "active", kind: "subscription", currentPeriodEnd: null };
const NOT_ENTITLED = { entitled: false, status: "none", kind: null, currentPeriodEnd: null };

const mobileAppsLive = vi.fn();
const notifyMobileInterest = vi.fn();
const checkHubDomain = vi.fn();
vi.mock("../lib/hubAccount", () => ({
  activationUrl: () => "https://mailpoppy.com/activate",
  checkHubDomain: (d: string) => checkHubDomain(d),
  mobileAppsLive: () => mobileAppsLive(),
  notifyMobileInterest: (e: string, d: string) => notifyMobileInterest(e, d),
  APP_STORE_URL: "https://apps.apple.com/app/id6781572431",
  PLAY_STORE_URL: "https://play.google.com/store/apps/details?id=com.mailpoppy.app",
}));

const openExternal = vi.fn();
vi.mock("../lib/openExternal", () => ({ openExternal: (u: string) => openExternal(u) }));

const deployment = { region: "eu-west-1", userPoolId: "p", clientId: "c", apiBaseUrl: "https://api" };

beforeEach(() => {
  getDomainStanding.mockReset().mockResolvedValue(NOT_ENTITLED);
  getTrialDays.mockReset().mockResolvedValue(null);
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

  // The regression that shipped on launch day: an admin who had ALREADY PAID was told the apps
  // were "coming soon to the App Store & Google Play" — the one screen that must hand them the
  // links to give their mailbox users.
  it("when the domain is on, hands the admin the real store links", async () => {
    mobileAppsLive.mockResolvedValue(true);
    getDomainStanding.mockResolvedValue(ENTITLED);
    checkHubDomain.mockResolvedValue("current" as HubDomainStatus);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByText(/On for ollydigital\.com/i)).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /App Store/i }));
    expect(openExternal).toHaveBeenCalledWith("https://apps.apple.com/app/id6781572431");

    fireEvent.click(screen.getByRole("button", { name: /Google Play/i }));
    expect(openExternal).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=com.mailpoppy.app",
    );
  });


  // The free trial is configured in the AgentsPoppy admin, not in MailPoppy — these two tests pin
  // that BOTH ends of it reach the user: the offer before buying, and the countdown after.
  it("offers the trial on the purchase button, with the length the admin configured", async () => {
    mobileAppsLive.mockResolvedValue(true);
    getTrialDays.mockResolvedValue(7);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByRole("button", { name: /Start 7-day free trial/i })).toBeInTheDocument();
    expect(screen.getByText(/Free for 7 days, then the subscription starts/i)).toBeInTheDocument();
  });

  it("counts the trial down from the entitlement's period end while it runs", async () => {
    const inFiveDays = Date.now() + 5 * 86_400_000 + 3_600_000; // 5 days + 1h → "6 days left"
    mobileAppsLive.mockResolvedValue(true);
    getDomainStanding.mockResolvedValue({
      entitled: true,
      status: "trialing",
      kind: "subscription",
      currentPeriodEnd: inFiveDays,
    });
    checkHubDomain.mockResolvedValue("current" as HubDomainStatus);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByText(/Free trial — 6 days left/i)).toBeInTheDocument();
    // Access is real during the trial: the store links are there, not a paywall.
    expect(screen.getByRole("button", { name: /App Store/i })).toBeInTheDocument();
  });

  it("shows no countdown when the API omits the period end (older AgentsPoppy)", async () => {
    mobileAppsLive.mockResolvedValue(true);
    getDomainStanding.mockResolvedValue({
      entitled: true,
      status: "trialing",
      kind: "subscription",
      currentPeriodEnd: null,
    });
    checkHubDomain.mockResolvedValue("current" as HubDomainStatus);
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    await screen.findByText(/On for ollydigital\.com/i);
    expect(screen.queryByText(/Free trial/i)).toBeNull(); // degrade quietly, never a blank countdown
  });

  it("defaults to coming-soon (no buy button) if the live check fails", async () => {
    mobileAppsLive.mockRejectedValue(new Error("network"));
    render(<MobileAppAccess domain="ollydigital.com" deployment={deployment} />);

    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up mobile access/i })).toBeNull();
  });
});
