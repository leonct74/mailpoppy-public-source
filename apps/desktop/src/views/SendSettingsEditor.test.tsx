import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { SendSettingsEditor } from "./SendSettingsEditor";
import type { SendSettings } from "@mailpoppy/core";

afterEach(() => cleanup());

const MB = 1024 * 1024;

describe("SendSettingsEditor", () => {
  it("shows the current limit in MB", async () => {
    render(<SendSettingsEditor stackName="MailpoppyMailStack" load={async () => ({ maxAttachmentBytes: 10 * MB })} />);
    expect(await screen.findByLabelText("Max attachment size in MB")).toHaveValue("10");
  });

  it("saves the chosen size as bytes", async () => {
    const save = vi.fn(async (i: { stackName: string; maxAttachmentBytes: number }) => ({
      ok: true as const,
      settings: { maxAttachmentBytes: i.maxAttachmentBytes } as SendSettings,
    }));
    render(
      <SendSettingsEditor
        stackName="MailpoppyMailStack"
        load={async () => ({ maxAttachmentBytes: 10 * MB })}
        save={save}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Max attachment size in MB"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /Save limit/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].maxAttachmentBytes).toBe(25 * MB);
  });

  it("clamps an out-of-range value to the 40 MB ceiling before saving", async () => {
    const save = vi.fn(async (i: { stackName: string; maxAttachmentBytes: number }) => ({
      ok: true as const,
      settings: { maxAttachmentBytes: i.maxAttachmentBytes } as SendSettings,
    }));
    render(
      <SendSettingsEditor
        stackName="MailpoppyMailStack"
        load={async () => ({ maxAttachmentBytes: 10 * MB })}
        save={save}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Max attachment size in MB"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /Save limit/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].maxAttachmentBytes).toBe(40 * MB);
  });
});
