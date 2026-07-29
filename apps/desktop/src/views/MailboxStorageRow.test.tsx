import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MailboxStorageRow } from "./MailboxStorageRow";
import type { MailboxStorageInfo } from "../lib/mailboxStorage";
import type { MailboxDeletion } from "../lib/mailbox";

afterEach(() => cleanup());

const storage: MailboxStorageInfo = { email: "old@acme.com", usedBytes: 1024, messageCount: 3, quotaBytes: null };
const loadStorage = async () => storage;
// Stub the embedded AgentOwnedToggle's loader so no test ever hits the sidecar.
const loadAgent = async () => ({ email: "old@acme.com", agentOwned: false });

describe("MailboxStorageRow — delete", () => {
  it("only arms the delete button once 'delete' is typed", async () => {
    const del = vi.fn(async (): Promise<MailboxDeletion> => ({
      ok: true,
      email: "old@acme.com",
      userDeleted: true,
      deletedMessages: 3,
      deletedObjects: 3,
      freedBytes: 1024,
    }));
    render(<MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} del={del} />);

    // Open the confirm.
    fireEvent.click(await screen.findByRole("button", { name: "Delete mailbox" }));
    // Warning + message count shown.
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/3 messages/)).toBeInTheDocument();

    // The armed "Delete mailbox" (red) button is disabled until "delete" is typed.
    const confirmBtn = screen.getAllByRole("button", { name: "Delete mailbox" }).at(-1)!;
    expect(confirmBtn).toBeDisabled();

    const input = screen.getByLabelText(/Type delete to confirm/i);
    fireEvent.change(input, { target: { value: "nope" } });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(input, { target: { value: "delete" } });
    expect(confirmBtn).toBeEnabled();
  });

  it("calls del + onDeleted when confirmed", async () => {
    const del = vi.fn(async (): Promise<MailboxDeletion> => ({
      ok: true,
      email: "old@acme.com",
      userDeleted: true,
      deletedMessages: 3,
      deletedObjects: 3,
      freedBytes: 1024,
    }));
    const onDeleted = vi.fn();
    render(
      <MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} del={del} onDeleted={onDeleted} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete mailbox" }));
    fireEvent.change(screen.getByLabelText(/Type delete to confirm/i), { target: { value: "DELETE" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete mailbox" }).at(-1)!);

    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del).toHaveBeenCalledWith({ stackName: "MailpoppyMailStack", email: "old@acme.com" });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("old@acme.com"));
  });

  it("surfaces a delete error and does not call onDeleted", async () => {
    const del = vi.fn(async () => {
      throw new Error("AccessDenied");
    });
    const onDeleted = vi.fn();
    render(
      <MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} del={del} onDeleted={onDeleted} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete mailbox" }));
    fireEvent.change(screen.getByLabelText(/Type delete to confirm/i), { target: { value: "delete" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Delete mailbox" }).at(-1)!);

    expect(await screen.findByText(/AccessDenied/)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe("MailboxStorageRow — open inbox", () => {
  it("shows an Open inbox action only when onOpenInbox is given, and passes the email", async () => {
    const onOpenInbox = vi.fn();
    const { rerender } = render(
      <MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} />,
    );
    // No action without the callback.
    await screen.findByText("old@acme.com");
    expect(screen.queryByRole("button", { name: /Open inbox for/ })).not.toBeInTheDocument();

    rerender(
      <MailboxStorageRow
        email="old@acme.com"
        stackName="MailpoppyMailStack"
        loadStorage={loadStorage} loadAgent={loadAgent}
        onOpenInbox={onOpenInbox}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open inbox for old@acme.com" }));
    expect(onOpenInbox).toHaveBeenCalledWith("old@acme.com");
  });
});

describe("MailboxStorageRow — reset password", () => {
  it("requires a password (≥8 chars) then calls resetPw and confirms", async () => {
    const resetPw = vi.fn(async () => ({ ok: true as const, email: "old@acme.com" }));
    render(
      <MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} resetPw={resetPw} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reset password" }));
    const setBtn = screen.getByRole("button", { name: "Set password" });
    expect(setBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/New password for old@acme.com/i), { target: { value: "short" } });
    expect(setBtn).toBeDisabled(); // < 8 chars

    fireEvent.change(screen.getByLabelText(/New password for old@acme.com/i), { target: { value: "Str0ng!Pass" } });
    expect(setBtn).toBeEnabled();

    fireEvent.click(setBtn);
    await waitFor(() => expect(resetPw).toHaveBeenCalledTimes(1));
    expect(resetPw).toHaveBeenCalledWith({ stackName: "MailpoppyMailStack", email: "old@acme.com", password: "Str0ng!Pass" });
    expect(await screen.findByText(/Password updated/i)).toBeInTheDocument();
  });

  it("surfaces a reset error", async () => {
    const resetPw = vi.fn(async () => {
      throw new Error("InvalidPasswordException: does not satisfy policy");
    });
    render(
      <MailboxStorageRow email="old@acme.com" stackName="MailpoppyMailStack" loadStorage={loadStorage} loadAgent={loadAgent} resetPw={resetPw} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reset password" }));
    fireEvent.change(screen.getByLabelText(/New password for old@acme.com/i), { target: { value: "Str0ng!Pass" } });
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));

    expect(await screen.findByText(/does not satisfy policy/i)).toBeInTheDocument();
  });
});
