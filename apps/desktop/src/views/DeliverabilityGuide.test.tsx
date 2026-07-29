import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { DeliverabilityGuide } from "./DeliverabilityGuide";

afterEach(() => cleanup());

describe("DeliverabilityGuide", () => {
  it("reassures that new-domain spam placement is normal and not MailPoppy's fault", () => {
    render(<DeliverabilityGuide />);
    expect(screen.getByText(/New domains often land in spam at first/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't something MailPoppy is doing wrong/i)).toBeInTheDocument();
  });

  it("credits the auth setup MailPoppy already does (DKIM/SPF/DMARC/MAIL FROM)", () => {
    render(<DeliverabilityGuide />);
    const groundwork = screen.getByText(/technical groundwork is already done/i);
    expect(groundwork).toBeInTheDocument();
    expect(groundwork.textContent).toMatch(/DKIM/);
    expect(groundwork.textContent).toMatch(/SPF/);
    expect(groundwork.textContent).toMatch(/DMARC/);
    expect(groundwork.textContent).toMatch(/MAIL FROM/);
  });

  it("gives a non-technical checklist of what the admin can do", () => {
    render(<DeliverabilityGuide />);
    // The expandable summary + a few of the concrete, plain-language steps.
    expect(screen.getByText(/How to land in the inbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Give it a little time/i)).toBeInTheDocument();
    expect(screen.getByText(/Ask your first recipients to rescue it/i)).toBeInTheDocument();
    expect(screen.getByText(/Only email people who expect it/i)).toBeInTheDocument();
  });
});
