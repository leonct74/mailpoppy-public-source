import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { InboxView } from "./InboxView";
import type { MailClient } from "../lib/mailClient";
import type { MessageMeta } from "@mailpoppy/core";

// globals:false → register cleanup manually (matches SetupWizard.test.tsx).
afterEach(() => cleanup());

function msg(over: Partial<MessageMeta> = {}): MessageMeta {
  return {
    domain: "ollydigital.com",
    mailbox: "you@ollydigital.com",
    messageId: "m1",
    threadId: "m1",
    folder: "inbox",
    from: { name: "Tester", address: "tester@ext.example" },
    to: [{ address: "you@ollydigital.com" }],
    subject: "Hello from test",
    snippet: "a short snippet",
    date: "2026-06-02T10:00:00.000Z",
    flags: { unread: true },
    hasAttachments: false,
    s3Key: "inbound/m1",
    sizeBytes: 1024,
    ...over,
  };
}

function mockClient(): MailClient & Record<"list" | "getRaw" | "getAttachmentUrl" | "setFlags" | "move" | "send" | "getUsage", ReturnType<typeof vi.fn>> {
  const inbox = [msg()];
  return {
    list: vi.fn(async ({ folder }) => ({ items: folder === "inbox" ? inbox : [] })),
    getRaw: vi.fn(async () => ({ eml: "From: tester@ext.example\r\n\r\nthe full body text" })),
    getAttachmentUrl: vi.fn(async () => ({ url: "https://signed.example/file", filename: "report.pdf" })),
    setFlags: vi.fn(async (_id: string, f) => ({ ...inbox[0]!, flags: { ...inbox[0]!.flags, ...f } })),
    move: vi.fn(async (_id: string, folder) => ({ ...inbox[0]!, folder })),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
    getUsage: vi.fn(async () => ({ email: "you@ollydigital.com", usedBytes: 1024, messageCount: 1, quotaBytes: 1024 ** 3 })),
  };
}

describe("InboxView", () => {
  it("lists messages from the client and shows the inbox", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    expect(await screen.findByRole("button", { name: "Open: Hello from test" })).toBeInTheDocument();
    expect(client.list).toHaveBeenCalledWith({ folder: "inbox", limit: 100 });
  });

  it("shows which mailbox is signed in", async () => {
    const client = mockClient();
    render(<InboxView client={client} mailboxEmail="you@ollydigital.com" />);

    expect(await screen.findByText("Signed in as")).toBeInTheDocument();
    expect(screen.getAllByText("you@ollydigital.com").length).toBeGreaterThan(0);
  });

  it("omits the mailbox identity header when no mailbox is given (e.g. demo mode)", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    await screen.findByRole("button", { name: "Open: Hello from test" });
    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();
  });

  it("opens a message, renders its body and marks it read", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open: Hello from test" }));

    expect(await screen.findByText(/the full body text/)).toBeInTheDocument();
    expect(client.getRaw).toHaveBeenCalledWith("m1");
    // It was unread → opening marks it read (async side effect).
    await waitFor(() => expect(client.setFlags).toHaveBeenCalledWith("m1", { unread: false }));
  });

  it("moves a message to trash and drops it from the list", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open: Hello from test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Move to Trash" }));

    expect(client.move).toHaveBeenCalledWith("m1", "trash");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open: Hello from test" })).toBeNull(),
    );
  });

  it("Reply prefills the compose dialog with the sender and a Re: subject", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open: Hello from test" }));
    fireEvent.click(await screen.findByRole("button", { name: /Reply$/ }));

    expect(await screen.findByRole("dialog", { name: "Compose message" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("tester@ext.example")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Re: Hello from test")).toBeInTheDocument();
  });

  it("previews a PDF attachment in-app (no browser bounce)", async () => {
    const withAttachment = msg({
      hasAttachments: true,
      attachments: [{ filename: "report.pdf", contentType: "application/pdf", sizeBytes: 2048, s3Key: "attachments/m1/0-report.pdf" }],
    });
    const client = mockClient();
    client.list = vi.fn(async ({ folder }) => ({ items: folder === "inbox" ? [withAttachment] : [] }));
    client.getAttachmentUrl = vi.fn(async () => ({ url: "https://signed.example/report.pdf", filename: "report.pdf" }));
    // The presigned URL is fetched for its bytes (the rasterising itself is
    // pdf.js's job — not exercisable in jsdom, where the viewer shows its fallback).
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]))) as unknown as typeof fetch;
    try {
      render(<InboxView client={client} />);

      fireEvent.click(await screen.findByRole("button", { name: "Open: Hello from test" }));
      fireEvent.click(await screen.findByRole("button", { name: /report\.pdf/ }));

      await waitFor(() => expect(client.getAttachmentUrl).toHaveBeenCalledWith("m1", 0));
      // The viewer opens IN the app, offering the silent save — no browser window.
      expect(await screen.findByRole("dialog", { name: /Preview: report\.pdf/ })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Save to Downloads/ })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: /Preview: report\.pdf/ })).not.toBeInTheDocument(),
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  it("compose sends an HTML body rendered from Markdown, plus a text fallback", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /Compose/ }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "x@y.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Hi" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "**bold** body" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(client.send).toHaveBeenCalled());
    const arg = client.send.mock.calls[0]![0];
    expect(arg.to).toEqual(["x@y.com"]);
    expect(arg.subject).toBe("Hi");
    expect(arg.text).toBe("**bold** body");
    expect(arg.html).toContain("<strong>bold</strong>");
  });

  it("attaches a file and includes it (base64) in the send", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(screen.getByRole("button", { name: /Compose/ }));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "x@y.com" } });
    const file = new File(["filedata"], "doc.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });

    expect(await screen.findByText(/doc\.txt/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(client.send).toHaveBeenCalled());
    const arg = client.send.mock.calls[0]![0];
    expect(arg.attachments).toHaveLength(1);
    expect(arg.attachments[0].filename).toBe("doc.txt");
    expect(atob(arg.attachments[0].contentBase64)).toBe("filedata");
  });

  it("filters the list as you type in the search box", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    // message present initially
    expect(await screen.findByRole("button", { name: "Open: Hello from test" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "tester" } });
    expect(screen.getByRole("button", { name: "Open: Hello from test" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search messages"), { target: { value: "nomatch" } });
    expect(screen.queryByRole("button", { name: "Open: Hello from test" })).toBeNull();
    expect(screen.getByText(/No messages match/)).toBeInTheDocument();
  });

  it("switches folders and queries the selected folder", async () => {
    const client = mockClient();
    render(<InboxView client={client} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sent" }));

    await waitFor(() => expect(client.list).toHaveBeenCalledWith({ folder: "sent", limit: 100 }));
    expect(await screen.findByText(/No messages in Sent/)).toBeInTheDocument();
  });
});
