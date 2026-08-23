import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RecipientVerify } from "./RecipientVerify";
import type { SesAccountStatus, RecipientVerification } from "@mailpoppy/core";

afterEach(() => cleanup());

const sandbox: SesAccountStatus = { productionAccessEnabled: false, sendingEnabled: true };
const production: SesAccountStatus = { productionAccessEnabled: true, sendingEnabled: true };

const notStarted: RecipientVerification = { email: "you@gmail.com", state: "not-started" };
const pending: RecipientVerification = { email: "you@gmail.com", state: "pending" };
const verified: RecipientVerification = { email: "you@gmail.com", state: "verified" };

describe("RecipientVerify", () => {
  it("renders nothing when the account has production access", async () => {
    const check = vi.fn(async () => notStarted);
    const { container } = render(
      <RecipientVerify recipient="you@gmail.com" domain="ollydigital.com" loadAccount={async () => production} check={check} />,
    );

    // Give the account load a tick to resolve, then confirm it stayed empty.
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(check).not.toHaveBeenCalled();
  });

  it("renders nothing when the account state can't be read (fail-safe)", async () => {
    const { container } = render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => {
          throw new Error("no sidecar");
        }}
        check={async () => notStarted}
      />,
    );
    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("in the sandbox, explains and offers to verify the typed address", async () => {
    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={async () => notStarted}
      />,
    );

    expect(await screen.findByText(/sandbox/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Verify you@gmail\.com with AWS/i })).toBeInTheDocument();
  });

  it("sends the verification email and flips to the pending state", async () => {
    const verify = vi.fn(async () => pending);
    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={async () => notStarted}
        verify={verify}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Verify you@gmail\.com with AWS/i }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith("you@gmail.com"));
    expect(await screen.findByText(/emailed a verification link/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-send the verification email/i })).toBeInTheDocument();
  });

  it("shows the verified state and reports it to the wizard", async () => {
    const onVerified = vi.fn();
    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={async () => verified}
        onVerified={onVerified}
      />,
    );

    expect(await screen.findByText(/is verified with AWS/i)).toBeInTheDocument();
    await waitFor(() => expect(onVerified).toHaveBeenCalledWith(true));
  });

  it("forceSandbox shows the panel even when the account read failed", async () => {
    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        forceSandbox
        loadAccount={async () => {
          throw new Error("no sidecar");
        }}
        check={async () => notStarted}
      />,
    );

    expect(await screen.findByText(/sandbox/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Verify you@gmail\.com with AWS/i })).toBeInTheDocument();
  });

  it("hides the verify controls while the recipient is invalid or on the setup domain", async () => {
    render(
      <RecipientVerify
        recipient="me@ollydigital.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={async () => notStarted}
      />,
    );

    // The sandbox explainer still shows, but no verify button for an address
    // the deliverability test itself would reject.
    expect(await screen.findByText(/sandbox/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with AWS/i })).toBeNull();
  });
});
