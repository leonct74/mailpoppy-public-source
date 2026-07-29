import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { AgentOwnedToggle } from "./AgentOwnedToggle";

afterEach(() => cleanup());

const off = async () => ({ email: "postie@acme.com", agentOwned: false });
const on = async () => ({ email: "postie@acme.com", agentOwned: true });

describe("AgentOwnedToggle", () => {
  it("enabling always passes through the privacy disclosure (spec §1, non-negotiable)", async () => {
    const save = vi.fn(async () => ({ ok: true as const, email: "postie@acme.com", agentOwned: true }));
    render(<AgentOwnedToggle email="postie@acme.com" stackName="MailpoppyMailStack" load={off} save={save} />);

    fireEvent.click(await screen.findByRole("button", { name: /Hand incoming mail to CrewPoppy agents/ }));

    // The exact disclosure sentence must be on screen BEFORE anything is saved.
    expect(
      screen.getByText(/NOT private the way human mailboxes are — its incoming mail is handed to an AI/),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Enable agent hand-off" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith({ stackName: "MailpoppyMailStack", email: "postie@acme.com", agentOwned: true });
    expect(await screen.findByText("🤖 Agent-owned")).toBeInTheDocument();
  });

  it("cancel closes the disclosure without saving", async () => {
    const save = vi.fn();
    render(<AgentOwnedToggle email="postie@acme.com" stackName="MailpoppyMailStack" load={off} save={save} />);

    fireEvent.click(await screen.findByRole("button", { name: /Hand incoming mail to CrewPoppy agents/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/NOT private the way human mailboxes are/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Hand incoming mail to CrewPoppy agents/ })).toBeInTheDocument();
  });

  it("an agent-owned mailbox shows the badge and turns off immediately (no confirm)", async () => {
    const save = vi.fn(async () => ({ ok: true as const, email: "postie@acme.com", agentOwned: false }));
    render(<AgentOwnedToggle email="postie@acme.com" stackName="MailpoppyMailStack" load={on} save={save} />);

    expect(await screen.findByText("🤖 Agent-owned")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ stackName: "MailpoppyMailStack", email: "postie@acme.com", agentOwned: false }),
    );
    expect(await screen.findByRole("button", { name: /Hand incoming mail to CrewPoppy agents/ })).toBeInTheDocument();
  });

  it("surfaces a save error and stays off", async () => {
    const save = vi.fn(async () => {
      throw new Error("settings table not found — deploy the backend first");
    });
    render(<AgentOwnedToggle email="postie@acme.com" stackName="MailpoppyMailStack" load={off} save={save} />);

    fireEvent.click(await screen.findByRole("button", { name: /Hand incoming mail to CrewPoppy agents/ }));
    fireEvent.click(screen.getByRole("button", { name: "Enable agent hand-off" }));

    expect(await screen.findByText(/deploy the backend first/)).toBeInTheDocument();
    expect(screen.queryByText("🤖 Agent-owned")).not.toBeInTheDocument();
  });
});
