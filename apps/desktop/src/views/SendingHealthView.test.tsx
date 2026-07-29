import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SendingHealthView } from "./SendingHealthView";
import type { DeliverabilityOverview, DeliverabilityStatus, DomainDeliverability } from "@mailpoppy/core";

afterEach(() => cleanup());

function account(p: Partial<DeliverabilityStatus> = {}): DeliverabilityStatus {
  return {
    totals: { deliveryAttempts: 100, bounces: 1, complaints: 0, rejects: 0 },
    bounceRate: 0.01,
    complaintRate: 0,
    windowDays: 14,
    sendingPaused: false,
    enforcementStatus: "HEALTHY",
    dailyUsed: 7,
    dailyLimit: 50000,
    suppressed: [],
    ...p,
  };
}
function domain(p: Partial<DomainDeliverability> & Pick<DomainDeliverability, "domain">): DomainDeliverability {
  return {
    sends: 100,
    bounces: 0,
    complaints: 0,
    bounceRate: 0,
    complaintRate: 0,
    suppressedCount: 0,
    windowDays: 14,
    ...p,
  };
}
const overview = (o: Partial<DeliverabilityOverview> = {}): DeliverabilityOverview => ({
  account: account(),
  domains: [],
  ...o,
});

describe("SendingHealthView", () => {
  it("shows the account-wide header (good standing + daily quota)", async () => {
    render(<SendingHealthView load={vi.fn(async () => overview())} />);
    expect(await screen.findByText("Your account is in good standing")).toBeInTheDocument();
    expect(screen.getByText(/7/)).toBeInTheDocument();
    expect(screen.getByText(/50,000/)).toBeInTheDocument();
  });

  it("lists every domain with its own health, worst-first signals visible", async () => {
    const data = overview({
      domains: [
        domain({ domain: "boxord.com", sends: 200, bounces: 0, complaints: 0, bounceRate: 0, complaintRate: 0 }),
        domain({ domain: "ollydigital.com", sends: 100, bounces: 8, complaints: 0, bounceRate: 0.08, complaintRate: 0 }),
      ],
    });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    expect(await screen.findByText("boxord.com")).toBeInTheDocument();
    expect(screen.getByText("ollydigital.com")).toBeInTheDocument();
    // the high-bounce domain reads "Needs attention" (also referenced in the
    // footer note, hence getAllByText), the clean one "Looking good"
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0);
    expect(screen.getByText("Looking good")).toBeInTheDocument();
    // bounce rate shown
    expect(screen.getByText(/8\.0%/)).toBeInTheDocument();
  });

  it("shows a 'no recent mail' state for an idle domain", async () => {
    const data = overview({ domains: [domain({ domain: "quiet.com", sends: 0 })] });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    expect(await screen.findByText("quiet.com")).toBeInTheDocument();
    expect(screen.getByText(/hasn't sent any email/)).toBeInTheDocument();
  });

  it("surfaces a paused account loudly, account-wide", async () => {
    render(<SendingHealthView load={vi.fn(async () => overview({ account: account({ sendingPaused: true }) }))} />);
    expect(await screen.findByText("Your sending is paused")).toBeInTheDocument();
  });

  it("notes a domain's do-not-send count", async () => {
    const data = overview({ domains: [domain({ domain: "boxord.com", sends: 50, suppressedCount: 2 })] });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    expect(await screen.findByText(/stopped emailing 2 addresses/)).toBeInTheDocument();
  });

  it("shows a domain's DMARC authentication once reports arrive", async () => {
    const data = overview({
      domains: [
        domain({
          domain: "boxord.com",
          sends: 100,
          dmarc: { reports: 3, volume: 200, pass: 200, fail: 0, failRate: 0, windowDays: 14 },
        }),
      ],
    });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    expect(await screen.findByText("Authentication (DMARC)")).toBeInTheDocument();
    expect(screen.getByText(/100% passed/)).toBeInTheDocument();
  });

  it("warns when a domain's mail is failing DMARC authentication", async () => {
    const data = overview({
      domains: [
        domain({
          domain: "boxord.com",
          sends: 100,
          dmarc: { reports: 2, volume: 100, pass: 60, fail: 40, failRate: 0.4, windowDays: 14 },
        }),
      ],
    });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    expect(await screen.findByText(/failed authentication/)).toBeInTheDocument();
    expect(screen.getByText(/60% passed/)).toBeInTheDocument();
  });

  it("omits the per-domain DMARC row until reports have arrived", async () => {
    const data = overview({ domains: [domain({ domain: "boxord.com", sends: 100 })] });
    render(<SendingHealthView load={vi.fn(async () => data)} />);
    await screen.findByText("boxord.com");
    // The card has no DMARC sub-row (the page-level footnote uses different wording).
    expect(screen.queryByText("Authentication (DMARC)")).not.toBeInTheDocument();
  });

  it("shows an empty state when no domains have mailboxes", async () => {
    render(<SendingHealthView load={vi.fn(async () => overview({ domains: [] }))} />);
    expect(await screen.findByText(/No domains with mailboxes yet/)).toBeInTheDocument();
  });

  it("surfaces a load error with a friendly message", async () => {
    render(
      <SendingHealthView
        load={vi.fn(async () => {
          throw new Error("sidecar 502: boom");
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText(/Couldn't check your sending health/)).toBeInTheDocument());
  });
});
