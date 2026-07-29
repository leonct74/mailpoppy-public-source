import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MailboxImport } from "./MailboxImport";
import type { MailboxImportPlan } from "@mailpoppy/core";

afterEach(() => cleanup());

const BACKEND = {
  ok: true as const,
  region: "eu-west-1",
  userPoolId: "pool",
  clientId: "client",
  apiBaseUrl: "https://api.example.com",
};

// A plan with: a create-only row, a create+migrate row, and a broken row.
function plan(): MailboxImportPlan {
  return {
    domain: "acme.com",
    validCount: 2,
    migrateCount: 1,
    errorCount: 1,
    rows: [
      { row: 1, email: "sales@acme.com", password: "S@les2026!", willMigrate: false, errors: [], warnings: [] },
      {
        row: 2,
        email: "joe@acme.com",
        password: "Welcome!23",
        willMigrate: true,
        imap: { host: "imap.old.com", user: "joe@acme.com", password: "oldpw", secure: true },
        errors: [],
        warnings: [],
      },
      { row: 3, email: "bad@other.com", password: "x", willMigrate: false, errors: ["address is on other.com, not acme.com"], warnings: [] },
    ],
  };
}

function deps(over: Partial<Parameters<typeof MailboxImport>[0]> = {}) {
  return {
    domain: "acme.com",
    stackName: "MailpoppyMailStack",
    readFileBase64: vi.fn(async () => "QkFTRTY0"),
    parse: vi.fn(async () => ({ ok: true as const, plan: plan() })),
    saveTemplate: vi.fn(async () => ({
      ok: true as const,
      path: "/Users/me/Downloads/mailpoppy-mailboxes-acme.com.xlsx",
      filename: "mailpoppy-mailboxes-acme.com.xlsx",
      dir: "/Users/me/Downloads",
    })),
    createMailbox: vi.fn(async (input: { email: string }) => ({ ...BACKEND, mailbox: { email: input.email, status: "CONFIRMED" } })),
    runMigration: vi.fn(async () => ({
      ok: true as const,
      host: "imap.old.com",
      mailbox: "joe@acme.com",
      dryRun: false,
      folders: [],
      totalImported: 5,
      totalSkipped: 0,
    })),
    ...over,
  };
}

function pickFile() {
  const input = screen.getByLabelText("Choose a spreadsheet to import");
  fireEvent.change(input, { target: { files: [new File(["x"], "mailboxes.xlsx")] } });
}

describe("MailboxImport", () => {
  it("makes the optional nature of IMAP explicit and saves the template to disk", async () => {
    const d = deps();
    render(<MailboxImport {...d} />);

    expect(screen.getByText(/the IMAP columns are/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Download template/i }));
    await waitFor(() => expect(d.saveTemplate).toHaveBeenCalledWith("acme.com"));
    // The UI confirms where the file landed (the webview can't pop a save dialog).
    expect(await screen.findByText(/Template saved as/i)).toBeInTheDocument();
    expect(screen.getByText("/Users/me/Downloads")).toBeInTheDocument();
  });

  it("parses a chosen file and previews valid/migrate/error counts per row", async () => {
    const d = deps();
    render(<MailboxImport {...d} />);

    pickFile();

    // Counts live in <b> nodes (matched separately by the call assertions below);
    // here we match the descriptive text around them.
    expect(await screen.findByText(/mailboxes to create/i)).toBeInTheDocument();
    expect(screen.getByText(/will also import old mail/i)).toBeInTheDocument();
    expect(screen.getByText(/problems and will be skipped/i)).toBeInTheDocument();
    // The bad row surfaces its reason.
    expect(screen.getByText(/address is on other\.com/)).toBeInTheDocument();
    expect(d.parse).toHaveBeenCalledWith({ domain: "acme.com", fileBase64: "QkFTRTY0", filename: "mailboxes.xlsx" });
  });

  it("creates only the valid rows and migrates the rows that opted in, then summarizes", async () => {
    const d = deps();
    render(<MailboxImport {...d} />);

    pickFile();
    fireEvent.click(await screen.findByRole("button", { name: /Create 2 mailboxes/i }));

    await waitFor(() => expect(d.createMailbox).toHaveBeenCalledTimes(2)); // not the broken row
    expect(d.createMailbox.mock.calls.map((c) => c[0].email)).toEqual(["sales@acme.com", "joe@acme.com"]);
    // Only the row that opted into IMAP migrates, into its own mailbox.
    await waitFor(() => expect(d.runMigration).toHaveBeenCalledTimes(1));
    expect(d.runMigration.mock.calls[0][0].mailbox).toBe("joe@acme.com");
    expect(d.runMigration.mock.calls[0][0].source.host).toBe("imap.old.com");

    expect(await screen.findByText(/Created/)).toBeInTheDocument();
    expect(screen.getByText(/imported mail for/i)).toBeInTheDocument();
  });

  it("treats an already-existing mailbox as success and still runs its migration", async () => {
    const d = deps({
      createMailbox: vi.fn(async () => {
        throw new Error("sidecar 400: UsernameExistsException: User account already exists");
      }),
    });
    render(<MailboxImport {...d} />);

    pickFile();
    fireEvent.click(await screen.findByRole("button", { name: /Create 2 mailboxes/i }));

    // joe@ still migrates despite the create "failing" with an exists error.
    await waitFor(() => expect(d.runMigration).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Created/)).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it("does not create anything when the file has no importable rows", async () => {
    const d = deps({
      parse: vi.fn(async () => ({
        ok: true as const,
        plan: { domain: "acme.com", validCount: 0, migrateCount: 0, errorCount: 1, rows: [
          { row: 1, email: "bad@other.com", password: "x", willMigrate: false, errors: ["address is on other.com, not acme.com"], warnings: [] },
        ] } satisfies MailboxImportPlan,
      })),
    });
    render(<MailboxImport {...d} />);

    pickFile();
    const runBtn = await screen.findByRole("button", { name: /Create 0 mailboxes|Create 0 mailbox/i });
    expect(runBtn).toBeDisabled();
  });
});
