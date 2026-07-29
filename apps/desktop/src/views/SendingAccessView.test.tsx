import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SendingAccessView } from "./SendingAccessView";
import type { SesAccountStatus } from "@mailpoppy/core";

afterEach(() => cleanup());

const sandbox: SesAccountStatus = {
  productionAccessEnabled: false,
  sendingEnabled: true,
  sendQuota: { max24Hour: 200, maxSendRate: 1, sentLast24Hours: 3 },
};
const production: SesAccountStatus = { productionAccessEnabled: true, sendingEnabled: true };
const pending: SesAccountStatus = { productionAccessEnabled: false, sendingEnabled: true, reviewStatus: "PENDING" };

describe("SendingAccessView", () => {
  it("shows the sandbox warning, the quota, and the request form", async () => {
    render(<SendingAccessView defaultWebsite="ollydigital.com" load={async () => sandbox} />);

    expect(await screen.findByText(/in the sandbox/i)).toBeInTheDocument();
    expect(screen.getByText(/Daily sending/i)).toBeInTheDocument();
    // Sandbox is a hard blocker, not optional — flag it as required.
    expect(screen.getByText(/Required to email anyone/i)).toBeInTheDocument();
    // Website prefilled from the domain being set up.
    expect(screen.getByLabelText("Website URL")).toHaveValue("https://ollydigital.com");
    expect(screen.getByRole("button", { name: /Request production access/i })).toBeInTheDocument();
  });

  it("shows the granted state and hides the form when out of the sandbox", async () => {
    render(<SendingAccessView load={async () => production} />);

    expect(await screen.findByText(/Production access granted/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request production access/i })).toBeNull();
    expect(screen.queryByLabelText("Website URL")).toBeNull();
    // No "required" flag once you're already in production.
    expect(screen.queryByText(/Required to email anyone/i)).toBeNull();
  });

  it("shows the under-review state when a request is pending", async () => {
    render(<SendingAccessView load={async () => pending} />);

    expect(await screen.findByText(/AWS is reviewing/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request production access/i })).toBeNull();
  });

  it("disables the request until the form is valid", async () => {
    // No defaultWebsite → URL empty → invalid → button disabled, problem listed.
    render(<SendingAccessView load={async () => sandbox} />);

    const requestBtn = await screen.findByRole("button", { name: /Request production access/i });
    expect(requestBtn).toBeDisabled();
    expect(screen.getByText(/valid website URL/i)).toBeInTheDocument();
  });

  it("confirms before submitting, then submits the request and reflects the pending state", async () => {
    const submit = vi.fn(async () => pending);
    render(<SendingAccessView defaultWebsite="ollydigital.com" load={async () => sandbox} submit={submit} />);

    fireEvent.click(await screen.findByRole("button", { name: /Request production access/i }));
    // Inline confirmation appears (no native confirm — webview-safe).
    expect(await screen.findByText(/This submits a request to/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Submit to AWS/i }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const req = submit.mock.calls[0]![0];
    expect(req.mailType).toBe("TRANSACTIONAL");
    expect(req.websiteUrl).toBe("https://ollydigital.com");
    expect(req.contactLanguage).toBe("EN");
    expect(req.useCaseDescription.length).toBeGreaterThanOrEqual(30);

    // After submit, status refreshes to the pending banner.
    expect(await screen.findByText(/AWS is reviewing/i)).toBeInTheDocument();
  });
});
