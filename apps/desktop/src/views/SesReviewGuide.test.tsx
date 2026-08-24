import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SesReviewGuide } from "./SesReviewGuide";

afterEach(() => cleanup());

vi.mock("../lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));
import { copyText } from "../lib/clipboard";

// Founder brief 2026-08-23: many MailPoppy admins have never used AWS and have never filed
// a support ticket. Telling them "we raised a ticket" leaves them waiting forever on a
// question they never saw. This guide is the fix, so its job is testable: say WHEN to check
// back, WHERE, what will be asked, and give them something to paste.
describe("SesReviewGuide", () => {
  it("tells the user to check back the next day, and where", () => {
    render(<SesReviewGuide />);
    expect(screen.getByText(/Tomorrow, even if you have heard nothing/i)).toBeInTheDocument();
    // The failure mode it exists to prevent, said out loud.
    expect(screen.getByText(/sitting there indefinitely/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /support cases/i })).toHaveAttribute(
      "href",
      "https://console.aws.amazon.com/support/home#/cases",
    );
  });

  it("keeps the detail behind a disclosure so the panel stays readable", () => {
    render(<SesReviewGuide />);
    expect(screen.queryByText(/who are you emailing/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /What Amazon will ask/i }));
    expect(screen.getByText(/who are you emailing/i)).toBeInTheDocument();
  });

  it("offers pasteable examples covering the realistic kinds of user", () => {
    render(<SesReviewGuide />);
    fireEvent.click(screen.getByRole("button", { name: /What Amazon will ask/i }));

    expect(screen.getByText(/staff email/i)).toBeInTheDocument();
    expect(screen.getByText(/online shop/i)).toBeInTheDocument();
    expect(screen.getByText(/freelancer/i)).toBeInTheDocument();

    // Each example must answer what AWS actually asks, or it invites more questions:
    // purpose, volume, who the recipients are, and bounce/complaint handling.
    const shop = screen.getByText(/ecommerce website/i).textContent ?? "";
    expect(shop).toMatch(/transactional/i);
    expect(shop).toMatch(/10,000 messages a day/i);
    expect(shop).toMatch(/bought from us|hold an account/i);
    expect(shop).toMatch(/Amazon's suppression list/i);
    // Nothing that would read as bulk mail to a bought list — that gets requests DENIED.
    expect(shop).toMatch(/do not buy or import address lists/i);
  });

  it("copies an example to the clipboard and confirms it", async () => {
    render(<SesReviewGuide />);
    fireEvent.click(screen.getByRole("button", { name: /What Amazon will ask/i }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Copy$/i })[0]);

    await waitFor(() => expect(copyText).toHaveBeenCalled());
    expect(vi.mocked(copyText).mock.calls[0][0]).toMatch(/staff mailboxes/i);
    expect(await screen.findByText(/Copied/i)).toBeInTheDocument();
  });

  // The send path does NOT consult MailPoppy's own suppression list (access-api.ts never
  // reads the SUPPRESS# rows suppression.ts writes). These examples are pasted into an AWS
  // compliance review, so they must credit Amazon's mechanism, never claim ours.
  it("never makes the user assert a MailPoppy behaviour we don't implement", () => {
    render(<SesReviewGuide />);
    fireEvent.click(screen.getByRole("button", { name: /What Amazon will ask/i }));
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/MailPoppy (automatically )?(stops sending|suppresses)/i);
    expect(body).toMatch(/Amazon's own suppression list/i);
  });

  it("is honest that MailPoppy cannot reply on the user's behalf", () => {
    render(<SesReviewGuide />);
    fireEvent.click(screen.getByRole("button", { name: /What Amazon will ask/i }));
    expect(screen.getByText(/you are the one who answers/i)).toBeInTheDocument();
  });
});
