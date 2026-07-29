import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { PolicyEditor } from "./PolicyEditor";
import type { SpamPolicy } from "@mailpoppy/core";

afterEach(() => cleanup());

const policy: SpamPolicy = {
  onVirus: "quarantine",
  onSpam: "junk",
  onAuthFail: "junk",
  allowList: ["boss@partner.com"],
  blockList: ["bad.com"],
};

describe("PolicyEditor", () => {
  it("shows the allow/block lists by default and hides verdict actions behind Advanced", async () => {
    render(<PolicyEditor stackName="MailpoppyMailStack" load={async () => policy} />);

    // Everyday controls are visible immediately.
    expect(await screen.findByLabelText("Allow list")).toHaveValue("boss@partner.com");
    expect(screen.getByLabelText("Block list")).toHaveValue("bad.com");
    // Verdict dropdowns are NOT shown until Advanced is opened.
    expect(screen.queryByLabelText("Spam action")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Advanced: spam/i }));

    expect(screen.getByText(/leave these at their defaults/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Spam action")).toHaveValue("junk");
    expect(screen.getByLabelText("Virus action")).toHaveValue("quarantine");
  });

  it("saves edited actions (via Advanced) and lists", async () => {
    const save = vi.fn(async (input: { stackName: string; policy: SpamPolicy }) => ({ ok: true as const, policy: input.policy }));
    render(<PolicyEditor stackName="MailpoppyMailStack" load={async () => policy} save={save} />);

    fireEvent.change(await screen.findByLabelText("Block list"), { target: { value: "bad.com\nspammer@evil.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Advanced: spam/i }));
    fireEvent.change(screen.getByLabelText("Spam action"), { target: { value: "reject" } });
    fireEvent.click(screen.getByRole("button", { name: /Save mail rules/i }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const arg = save.mock.calls[0]![0];
    expect(arg.policy.onSpam).toBe("reject");
    expect(arg.policy.blockList).toEqual(["bad.com", "spammer@evil.com"]);
    expect(arg.policy.allowList).toEqual(["boss@partner.com"]);
    expect(await screen.findByText(/Saved/i)).toBeInTheDocument();
  });

  it("saves the safe defaults unchanged when Advanced is never opened", async () => {
    const save = vi.fn(async (input: { stackName: string; policy: SpamPolicy }) => ({ ok: true as const, policy: input.policy }));
    render(<PolicyEditor stackName="MailpoppyMailStack" load={async () => policy} save={save} />);

    fireEvent.click(await screen.findByRole("button", { name: /Save mail rules/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const arg = save.mock.calls[0]![0];
    expect(arg.policy).toMatchObject({ onVirus: "quarantine", onSpam: "junk", onAuthFail: "junk" });
  });

  it("warns about entries that aren't a valid address or domain", async () => {
    render(<PolicyEditor stackName="MailpoppyMailStack" load={async () => policy} />);

    fireEvent.change(await screen.findByLabelText("Allow list"), { target: { value: "not-an-address" } });
    expect(await screen.findByText(/don't look like an address or domain/i)).toBeInTheDocument();
  });

  it("threads the domain scope into load + save when given one", async () => {
    const load = vi.fn(async (_stack: string, _domain?: string) => policy);
    const save = vi.fn(async (input: { stackName: string; policy: SpamPolicy; domain?: string }) => ({
      ok: true as const,
      policy: input.policy,
    }));
    render(<PolicyEditor stackName="MailpoppyMailStack" domain="boxord.com" load={load} save={save} />);

    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(load.mock.calls[0]).toEqual(["MailpoppyMailStack", "boxord.com"]);
    // The scope is surfaced to the admin.
    expect(screen.getByText("boxord.com")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save mail rules/i }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].domain).toBe("boxord.com");
  });
});
