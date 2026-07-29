import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { HomeView } from "./HomeView";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const ready = {
  listMailboxes: async () => ({
    region: "eu-west-1",
    mailboxes: [
      { email: "support@boxord.com", status: "CONFIRMED" },
      { email: "info@boxord.com", status: "CONFIRMED" },
      { email: "hello@example.org", status: "CONFIRMED" },
    ],
  }),
  listDomains: async () => ({ domains: ["boxord.com", "example.org"] }),
  listCloudDomains: async () => ({ region: "eu-west-1", domains: [] }),
  getAccount: async () => ({
    productionAccessEnabled: false,
    sendingEnabled: true,
    sendQuota: { max24Hour: 200, maxSendRate: 1, sentLast24Hours: 5 },
  }),
  getDomainStatus: async () => ({ verifiedForSending: true, dkim: "SUCCESS" }),
  getMailFrom: async (d: string) => ({ status: "Success", mailFromDomain: `mail.${d}` }),
};

describe("HomeView", () => {
  it("shows account posture and a card per domain with mailbox counts + health badges", async () => {
    render(<HomeView {...ready} />);

    // A card per domain.
    expect(await screen.findByText("boxord.com")).toBeInTheDocument();
    expect(screen.getByText("example.org")).toBeInTheDocument();

    // Per-domain mailbox counts (2 on boxord.com, 1 on example.org).
    expect(screen.getByText(/2 mailboxes/)).toBeInTheDocument();
    expect(screen.getByText(/1 mailbox\b/)).toBeInTheDocument();

    // Account posture: region + SES sandbox.
    expect(screen.getByText("eu-west-1")).toBeInTheDocument();
    expect(screen.getByText("Sandbox")).toBeInTheDocument();

    // Health badges resolve asynchronously (one per domain).
    expect((await screen.findAllByText("DKIM verified")).length).toBe(2);
    expect(screen.getAllByText("MAIL FROM aligned").length).toBe(2);
  });

  it("warns when a domain is set up in AWS but not reachable by the apps (never silent)", async () => {
    // A live backend must be known so the Hub check can run (and tell current from stale).
    localStorage.setItem(
      "mailpoppy.deployment",
      JSON.stringify({
        apiBaseUrl: "https://h7poaooahc.execute-api.eu-west-1.amazonaws.com",
        userPoolId: "eu-west-1_cj7e4w3sZ",
        clientId: "63cs9fep5jbsk7rcb98rs8eln4",
        region: "eu-west-1",
      }),
    );
    // boxord.com is dark to the apps (the "reinstall lost my domain" case); example.org is fine.
    const checkHub = vi.fn(async (domain: string) =>
      domain === "boxord.com" ? ("unregistered" as const) : ("current" as const),
    );
    const open = vi.fn();

    render(<HomeView {...ready} checkHub={checkHub} open={open} />);

    // The broken domain is flagged, loudly and specifically…
    expect(await screen.findByText("Not activated for apps")).toBeInTheDocument();
    // …and the healthy one reads active — so the warning is meaningful, not blanket.
    expect(await screen.findByText("Apps active")).toBeInTheDocument();
    expect(checkHub).toHaveBeenCalledWith("boxord.com", expect.objectContaining({ userPoolId: "eu-west-1_cj7e4w3sZ" }));

    // …and an always-on, account-level banner names the affected domain so the drift
    // (e.g. after a reinstall/rebuild) can never hide.
    expect(await screen.findByText(/1 domain isn't reachable by the mobile & web apps/)).toBeInTheDocument();
    expect(screen.getByText("boxord.com", { selector: "span" })).toBeInTheDocument();

    // …with a one-click Re-activate that opens the domain's pre-filled activation page.
    const reactivate = await screen.findByRole("button", { name: /Re-activate/ });
    fireEvent.click(reactivate);
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/\/activate\?domain=boxord\.com/));
  });

  it("shows no app-access banner when every domain is active in the apps", async () => {
    localStorage.setItem(
      "mailpoppy.deployment",
      JSON.stringify({
        apiBaseUrl: "https://h7poaooahc.execute-api.eu-west-1.amazonaws.com",
        userPoolId: "eu-west-1_cj7e4w3sZ",
        clientId: "63cs9fep5jbsk7rcb98rs8eln4",
        region: "eu-west-1",
      }),
    );
    render(<HomeView {...ready} checkHub={async () => "current" as const} />);

    expect(await screen.findByText("boxord.com")).toBeInTheDocument();
    expect((await screen.findAllByText("Apps active")).length).toBe(2);
    expect(screen.queryByText(/reachable by the mobile & web apps/)).not.toBeInTheDocument();
  });

  it("does NOT offer to remove infrastructure while domains exist", async () => {
    render(<HomeView {...ready} />);
    await screen.findByText("boxord.com");
    expect(screen.queryByText("Remove leftover infrastructure")).not.toBeInTheDocument();
  });

  it("offers a guarded full teardown when the backend is deployed but no domains remain", async () => {
    const teardown = vi.fn(async () => ({
      ok: true as const,
      domain: "",
      domains: [],
      stackName: "MailpoppyMailStack",
      deleted: ["CloudFormation stack MailpoppyMailStack", "S3 bucket mailpoppy-mail-x"],
      warnings: [],
    }));
    render(
      <HomeView
        {...ready}
        listMailboxes={async () => ({ region: "eu-west-1", mailboxes: [] })}
        listDomains={async () => ({ domains: [] })}
        teardown={teardown}
      />,
    );

    // The danger zone appears (backend deployed + zero domains).
    const toggle = await screen.findByText("Remove leftover infrastructure");
    fireEvent.click(toggle);

    // Gated: the button is disabled until "DELETE" is typed.
    const remove = screen.getByRole("button", { name: /Remove infrastructure/i });
    expect(remove).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type DELETE to confirm/i), { target: { value: "DELETE" } });
    expect(remove).not.toBeDisabled();

    fireEvent.click(remove);
    await waitFor(() => expect(teardown).toHaveBeenCalledWith({ stackName: "MailpoppyMailStack" }));
    // Result summary surfaces what was deleted.
    expect(await screen.findByText(/Infrastructure removed/i)).toBeInTheDocument();
    expect(screen.getByText(/CloudFormation stack MailpoppyMailStack/)).toBeInTheDocument();
  });

  it("hides the teardown when the backend can't be confirmed (e.g. a fresh account)", async () => {
    // The teardown-discover endpoint returns [] even with no stack, while the
    // mailbox read fails for a non-"no backend" reason. The destructive control
    // must NOT appear without positive proof a backend exists.
    render(
      <HomeView
        {...ready}
        listMailboxes={async () => {
          throw new Error('sidecar 500: {"ok":false,"error":"AccessDenied"}');
        }}
        listDomains={async () => ({ domains: [] })}
      />,
    );
    await screen.findByText(/Your domains/i);
    expect(screen.queryByText("Remove leftover infrastructure")).not.toBeInTheDocument();
    // Backend posture is honest about the uncertainty.
    expect(screen.getByText("unavailable")).toBeInTheDocument();
  });

  it("guides to Setup when no backend is deployed yet", async () => {
    const onGoToSetup = vi.fn();
    const noBackend = () =>
      Promise.reject(new Error('sidecar 404: {"ok":false,"error":"No deployed MailPoppy backend was found yet."}'));
    render(
      <HomeView
        onGoToSetup={onGoToSetup}
        listMailboxes={noBackend}
        listDomains={noBackend}
        getAccount={noBackend}
        listCloudDomains={async () => ({ region: "eu-west-1", domains: [] })}
      />,
    );

    const btn = await screen.findByRole("button", { name: /Set up your first domain/ });
    fireEvent.click(btn);
    expect(onGoToSetup).toHaveBeenCalled();
  });

  it("surfaces SES domains already in the user's AWS that MailPoppy doesn't manage yet, and lets them be adopted", async () => {
    const onSetupDomain = vi.fn();
    render(
      <HomeView
        {...ready}
        // The cloud has the two managed domains PLUS a legacy one set up outside MailPoppy.
        listCloudDomains={async () => ({
          region: "eu-west-1",
          domains: [
            { name: "boxord.com", verified: true, sendingEnabled: true },
            { name: "example.org", verified: true, sendingEnabled: true },
            { name: "legacy.com", verified: true, sendingEnabled: true },
          ],
        })}
        onSetupDomain={onSetupDomain}
      />,
    );

    // The unmanaged one is surfaced under "Also in your AWS"…
    expect(await screen.findByText("Also in your AWS")).toBeInTheDocument();
    expect(screen.getByText("legacy.com")).toBeInTheDocument();
    // …while the already-managed ones are NOT duplicated into that section.
    expect(screen.getAllByText("boxord.com").length).toBe(1);

    // Adopting it hands off to the setup flow for that exact domain.
    fireEvent.click(screen.getByRole("button", { name: /Set up with MailPoppy/i }));
    expect(onSetupDomain).toHaveBeenCalledWith("legacy.com");
  });

  it("shows pre-existing cloud domains even when no MailPoppy backend is deployed yet", async () => {
    const noBackend = () =>
      Promise.reject(new Error('sidecar 404: {"ok":false,"error":"No deployed MailPoppy backend was found yet."}'));
    render(
      <HomeView
        listMailboxes={noBackend}
        listDomains={noBackend}
        getAccount={noBackend}
        listCloudDomains={async () => ({
          region: "eu-west-1",
          domains: [{ name: "boxord.com", verified: false, sendingEnabled: true }],
        })}
        onSetupDomain={vi.fn()}
      />,
    );

    // The onboarding card is shown, AND the existing domain isn't hidden.
    expect(await screen.findByText("Also in your AWS")).toBeInTheDocument();
    expect(screen.getByText("boxord.com")).toBeInTheDocument();
    expect(screen.getByText("not verified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up with MailPoppy/i })).toBeInTheDocument();
  });

  it("surfaces a timeout (with Retry) instead of an infinite spinner when a backend call hangs", async () => {
    vi.useFakeTimers();
    try {
      const hang = () => new Promise<never>(() => {}); // never settles — models a wedged backend call
      render(<HomeView {...ready} listMailboxes={hang} listDomains={hang} getAccount={hang} />);

      // Before the timeout it's still loading…
      expect(screen.getByText(/Loading your domains and mailboxes/)).toBeInTheDocument();

      // …and once the load timeout elapses it resolves into the actionable error state.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      expect(screen.getByText("Couldn't load your overview")).toBeInTheDocument();
      expect(screen.getByText(/Timed out loading/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
