import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MailFromSetup } from "./MailFromSetup";
import type { MailFromState } from "@mailpoppy/core";

afterEach(() => cleanup());

const notConfigured: MailFromState = { behaviorOnMxFailure: "USE_DEFAULT_VALUE" };
const pending: MailFromState = { mailFromDomain: "mail.ollydigital.com", status: "PENDING" };
const aligned: MailFromState = { mailFromDomain: "mail.ollydigital.com", status: "SUCCESS" };

describe("MailFromSetup", () => {
  it("when not configured, previews the records and offers setup", async () => {
    render(<MailFromSetup domain="ollydigital.com" load={async () => notConfigured} />);

    expect(await screen.findByText(/Not configured yet/i)).toBeInTheDocument();
    // Region-specific feedback MX + SPF preview.
    expect(screen.getByText("10 feedback-smtp.eu-west-1.amazonses.com")).toBeInTheDocument();
    expect(screen.getByText('"v=spf1 include:amazonses.com ~all"')).toBeInTheDocument();
    // Marked recommended so an evaluating admin understands it's worth enabling.
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up custom MAIL FROM \(recommended\)/i })).toBeInTheDocument();
  });

  it("shows the aligned state when verified", async () => {
    render(<MailFromSetup domain="ollydigital.com" load={async () => aligned} />);

    expect(await screen.findByText(/Custom MAIL FROM active/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Set up custom MAIL FROM/i })).toBeNull();
  });

  it("shows the verifying state with a refresh button when pending", async () => {
    render(<MailFromSetup domain="ollydigital.com" load={async () => pending} />);

    expect(await screen.findByText(/SES is verifying/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check verification status/i })).toBeInTheDocument();
  });

  it("confirms before applying, then runs setup and reflects the pending state", async () => {
    const setup = vi.fn(async () => ({
      mailFromDomain: "mail.ollydigital.com",
      records: [],
      state: pending,
    }));
    render(<MailFromSetup domain="ollydigital.com" load={async () => notConfigured} setup={setup} />);

    fireEvent.click(await screen.findByRole("button", { name: /Set up custom MAIL FROM/i }));
    expect(await screen.findByText(/adds the DNS records above/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Apply DNS changes/i }));

    await waitFor(() => expect(setup).toHaveBeenCalledWith({ domain: "ollydigital.com" }));
    expect(await screen.findByText(/SES is verifying/i)).toBeInTheDocument();
  });
});
