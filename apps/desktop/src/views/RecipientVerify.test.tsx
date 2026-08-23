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

  // The panel promises "This panel updates by itself once it's clicked". It did not:
  // the first check returns not-started (no identity exists yet) so no poll timer was
  // ever armed, and clicking Verify changed no effect dependency — so after the user
  // clicked the AWS link the spinner stayed forever (field bug 2026-08-23). Three
  // independent reviewers reproduced it against the real component.
  it("keeps polling after Verify is clicked, and flips to verified when AWS confirms", async () => {
    let state: RecipientVerification = notStarted;
    const check = vi.fn(async () => state);
    const verify = vi.fn(async () => {
      state = pending;
      return pending;
    });

    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={check}
        verify={verify}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Verify you@gmail\.com with AWS/i }));
    expect(await screen.findByText(/emailed a verification link/i)).toBeInTheDocument();

    const afterClick = check.mock.calls.length;
    // The user clicks the link in their inbox; AWS flips the identity.
    state = verified;
    // The panel must notice on its own — no further user action.
    await waitFor(() => expect(check.mock.calls.length).toBeGreaterThan(afterClick), { timeout: 8000 });
    expect(await screen.findByText(/is verified with AWS/i)).toBeInTheDocument();
  }, 15000);

  // A single failed poll used to end the loop permanently (the catch swallowed it and
  // re-armed nothing), stranding the user on a spinner that could never update.
  it("survives a transient check failure while waiting and still reaches verified", async () => {
    let state: RecipientVerification = pending;
    let calls = 0;
    const check = vi.fn(async () => {
      calls++;
      if (calls === 2) throw new Error("broker hiccup");
      return state;
    });

    render(
      <RecipientVerify
        recipient="you@gmail.com"
        domain="ollydigital.com"
        loadAccount={async () => sandbox}
        check={check}
      />,
    );

    expect(await screen.findByText(/emailed a verification link/i)).toBeInTheDocument();
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    state = verified;
    expect(await screen.findByText(/is verified with AWS/i, undefined, { timeout: 10000 })).toBeInTheDocument();
  }, 20000);

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
