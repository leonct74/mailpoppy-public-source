import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { SandboxNotice } from "./SandboxNotice";
import type { SesAccountStatus } from "@mailpoppy/core";

afterEach(() => cleanup());

const sandbox: SesAccountStatus = { productionAccessEnabled: false, sendingEnabled: true };
const pending: SesAccountStatus = { productionAccessEnabled: false, sendingEnabled: true, reviewStatus: "PENDING" };
const production: SesAccountStatus = { productionAccessEnabled: true, sendingEnabled: true };

// Founder brief 2026-08-23: warn a brand-new user BEFORE they spend an hour setting up a
// domain and mailboxes that turn out not to be able to email anyone.
describe("SandboxNotice", () => {
  it("warns a sandboxed account, and is honest about who must answer AWS", async () => {
    render(<SandboxNotice load={async () => sandbox} />);

    expect(await screen.findByText(/Amazon limits new accounts/i)).toBeInTheDocument();
    expect(screen.getByText(/can be set up but not really used/i)).toBeInTheDocument();
    expect(screen.getByText(/only you can answer those/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Support Center/i })).toHaveAttribute(
      "href",
      "https://console.aws.amazon.com/support/home#/cases",
    );
    // The founder's explicit ask: don't scare off someone it doesn't apply to.
    expect(screen.getByText(/Already had the sandbox limit removed/i)).toBeInTheDocument();
  });

  // Assuming the worst is right here: on this screen there are usually no credentials yet,
  // and a brand-new AWS account IS sandboxed. Staying silent would be the harmful default.
  it("keeps the warning when the account can't be read at all", async () => {
    render(
      <SandboxNotice
        load={async () => {
          throw new Error("no credentials yet");
        }}
      />,
    );
    expect(await screen.findByText(/Amazon limits new accounts/i)).toBeInTheDocument();
  });

  it("still warns while a request is only pending — it isn't lifted yet", async () => {
    render(<SandboxNotice load={async () => pending} />);
    expect(await screen.findByText(/Amazon limits new accounts/i)).toBeInTheDocument();
  });

  it("does NOT warn an account that already has production access", async () => {
    render(<SandboxNotice load={async () => production} />);

    expect(await screen.findByText(/can already email anyone/i)).toBeInTheDocument();
    expect(screen.queryByText(/Amazon limits new accounts/i)).not.toBeInTheDocument();
    // And it invites them onward rather than leaving a bare green tick.
    expect(screen.getByText(/as many domains and mailboxes as you like/i)).toBeInTheDocument();
  });

  it("shows the warning first, before the account read resolves", () => {
    render(<SandboxNotice load={() => new Promise(() => {})} />);
    expect(screen.getByText(/Amazon limits new accounts/i)).toBeInTheDocument();
  });
});
