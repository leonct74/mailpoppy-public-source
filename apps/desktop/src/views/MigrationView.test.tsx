import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MigrationView } from "./MigrationView";
import type { ImapFolderInfo, MigrateSummary } from "../lib/migration";

afterEach(() => cleanup());

const folders: ImapFolderInfo[] = [
  { path: "INBOX", name: "INBOX", mappedFolder: "inbox", messages: 12 },
  { path: "Sent Items", name: "Sent Items", specialUse: "\\Sent", mappedFolder: "sent", messages: 5 },
  { path: "Projects", name: "Projects", mappedFolder: "projects", messages: 0 },
];

// The destination is now a picker populated from the deployed backend's
// mailboxes, so tests inject a mailbox list (two domains) and select from it.
const loadMailboxes = async () => ({
  ok: true as const,
  region: "eu-west-1",
  userPoolId: "pool-1",
  clientId: "client-1",
  apiBaseUrl: "https://api.example.com",
  mailboxes: [
    { email: "you@yourdomain.com", status: "CONFIRMED" },
    { email: "team@otherdomain.com", status: "CONFIRMED" },
  ],
});

async function fill() {
  fireEvent.change(screen.getByLabelText("IMAP host"), { target: { value: "imap.example.com" } });
  fireEvent.change(screen.getByLabelText("IMAP username"), { target: { value: "old@example.com" } });
  fireEvent.change(screen.getByLabelText("IMAP password"), { target: { value: "secret" } });
  // The destination picker loads asynchronously; open it and choose a mailbox.
  fireEvent.click(await screen.findByRole("button", { name: "Destination mailbox" }));
  fireEvent.click(await screen.findByRole("option", { name: "you@yourdomain.com" }));
}

describe("MigrationView", () => {
  it("tests the connection and lists folders with their mapped MailPoppy folder", async () => {
    const test = vi.fn(async () => ({ ok: true as const, folders }));
    const run = vi.fn();
    render(<MigrationView test={test} run={run} loadMailboxes={loadMailboxes} />);

    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText("INBOX")).toBeInTheDocument();
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com", user: "old@example.com", password: "secret" }),
    );
    // The Sent Items → sent mapping is shown.
    expect(screen.getByText("sent")).toBeInTheDocument();
  });

  it("imports only the selected (non-empty) folders and shows the summary", async () => {
    const test = vi.fn(async () => ({ ok: true as const, folders }));
    const summary: MigrateSummary & { ok: true } = {
      ok: true,
      host: "imap.example.com",
      mailbox: "you@yourdomain.com",
      dryRun: false,
      folders: [
        { path: "INBOX", mappedFolder: "inbox", imported: 12, skipped: 0 },
        { path: "Sent Items", mappedFolder: "sent", imported: 5, skipped: 0 },
      ],
      totalImported: 17,
      totalSkipped: 0,
    };
    const run = vi.fn(async () => summary);
    render(<MigrationView test={test} run={run} loadMailboxes={loadMailboxes} />);

    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("INBOX");

    // Empty "Projects" folder is not pre-selected → import button counts 2 folders.
    fireEvent.click(screen.getByRole("button", { name: /Import 2 folders/ }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    const arg = run.mock.calls[0]![0];
    expect(arg.mailbox).toBe("you@yourdomain.com");
    expect(arg.folders.sort()).toEqual(["INBOX", "Sent Items"]);
    expect(arg.dryRun).toBe(false);

    expect(await screen.findByText(/Import complete/)).toBeInTheDocument();
    expect(screen.getByText(/Imported 17 messages/)).toBeInTheDocument();
  });

  it("surfaces a connection error", async () => {
    const test = vi.fn(async () => {
      throw new Error("AUTHENTICATIONFAILED");
    });
    render(<MigrationView test={test} run={vi.fn()} loadMailboxes={loadMailboxes} />);

    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/AUTHENTICATIONFAILED/)).toBeInTheDocument();
  });

  it("preselects a mailbox on the domain the user drilled in from", async () => {
    render(<MigrationView test={vi.fn()} run={vi.fn()} loadMailboxes={loadMailboxes} preselectDomain="otherdomain.com" />);

    // The destination trigger should show the otherdomain.com mailbox, not the
    // first mailbox overall (you@yourdomain.com).
    expect(await screen.findByText("team@otherdomain.com")).toBeInTheDocument();
    expect(screen.queryByText("Select a mailbox…")).not.toBeInTheDocument();
  });

  it("passes dryRun when 'Preview only' is checked", async () => {
    const test = vi.fn(async () => ({ ok: true as const, folders }));
    const run = vi.fn(async () => ({
      ok: true as const,
      host: "imap.example.com",
      mailbox: "you@yourdomain.com",
      dryRun: true,
      folders: [{ path: "INBOX", mappedFolder: "inbox", imported: 12, skipped: 0 }],
      totalImported: 12,
      totalSkipped: 0,
    }));
    render(<MigrationView test={test} run={run} loadMailboxes={loadMailboxes} />);

    await fill();
    fireEvent.click(screen.getByLabelText("Preview only"));
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await screen.findByText("INBOX");
    fireEvent.click(screen.getByRole("button", { name: /Preview selected/ }));

    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]![0].dryRun).toBe(true);
    expect(await screen.findByText(/would be imported/)).toBeInTheDocument();
  });
});
