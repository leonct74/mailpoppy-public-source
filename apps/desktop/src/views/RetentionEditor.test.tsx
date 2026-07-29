import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RetentionEditor } from "./RetentionEditor";
import type { RetentionSettings } from "@mailpoppy/core";

afterEach(() => cleanup());

const keepForever: RetentionSettings = { trashPurgeDays: 30, retentionDays: null };

describe("RetentionEditor", () => {
  it("defaults to keep-indefinitely with a 30-day Trash purge", async () => {
    render(<RetentionEditor stackName="MailpoppyMailStack" load={async () => keepForever} />);
    expect(await screen.findByLabelText("Trash purge days")).toHaveValue("30");
    // Keep-indefinitely selected → no permanent-delete warning.
    expect(screen.queryByText(/permanently deletes/i)).toBeNull();
  });

  it("saves keep-indefinitely as retentionDays null", async () => {
    const save = vi.fn(async (i: { stackName: string; retention: RetentionSettings }) => ({ ok: true as const, retention: i.retention }));
    render(<RetentionEditor stackName="MailpoppyMailStack" load={async () => keepForever} save={save} />);
    fireEvent.click(await screen.findByRole("button", { name: /Save retention/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].retention).toEqual({ trashPurgeDays: 30, retentionDays: null });
  });

  it("warns and saves a delete-after window when chosen", async () => {
    const save = vi.fn(async (i: { stackName: string; retention: RetentionSettings }) => ({ ok: true as const, retention: i.retention }));
    render(<RetentionEditor stackName="MailpoppyMailStack" load={async () => keepForever} save={save} />);

    fireEvent.click(await screen.findByLabelText("Delete mail after a set time"));
    fireEvent.change(screen.getByLabelText("Retention days"), { target: { value: "180" } });
    expect(screen.getByText(/permanently deletes/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save retention/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].retention).toEqual({ trashPurgeDays: 30, retentionDays: 180 });
  });

  it("threads the domain scope into load + save when given one", async () => {
    const load = vi.fn(async (_stack: string, _domain?: string) => keepForever);
    const save = vi.fn(async (i: { stackName: string; retention: RetentionSettings; domain?: string }) => ({
      ok: true as const,
      retention: i.retention,
    }));
    render(<RetentionEditor stackName="MailpoppyMailStack" domain="boxord.com" load={load} save={save} />);

    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(load.mock.calls[0]).toEqual(["MailpoppyMailStack", "boxord.com"]);
    expect(screen.getByText(/boxord\.com/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save retention/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].domain).toBe("boxord.com");
  });
});
