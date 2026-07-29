import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AccountView } from "./AccountView";

// The composed children self-load from the sidecar; stub them so this test
// focuses on AccountView's own job: surfacing the genuinely account-wide
// concerns — SES sending access + the AWS resource inventory. Mail rules and
// retention are per-domain now and live in the domain workspace, not here.
vi.mock("./SendingAccessView", () => ({ SendingAccessView: () => <div>SENDING STUB</div> }));
// ResourcesView hosts the actionable panels via its afterSummary slot (they must render
// right after the summary card, above the long tables) — the stub renders the slot too.
vi.mock("./ResourcesView", () => ({
  ResourcesView: ({ afterSummary }: { afterSummary?: React.ReactNode }) => (
    <div>
      RESOURCES STUB
      {afterSummary}
    </div>
  ),
}));

afterEach(() => cleanup());

describe("AccountView", () => {
  it("shows account-wide sending access and the AWS resource inventory", () => {
    render(<AccountView />);
    expect(screen.getByText("SENDING STUB")).toBeInTheDocument();
    expect(screen.getByText("RESOURCES STUB")).toBeInTheDocument();
  });

  it("does not host the per-domain mail rules or retention editors, and points to the domain workspace", () => {
    render(<AccountView />);
    // No editors here any more.
    expect(screen.queryByLabelText("Mail rules")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Retention")).not.toBeInTheDocument();
    // The copy steers the admin to set them per domain.
    expect(screen.getByText(/per domain/i)).toBeInTheDocument();
  });
});
