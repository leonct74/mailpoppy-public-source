import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { RegionPicker } from "./RegionPicker";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const cfg = { region: "eu-west-1", available: ["eu-west-1", "us-east-1", "us-west-2"] };

describe("RegionPicker", () => {
  it("shows the available regions and the current selection", async () => {
    render(<RegionPicker load={async () => cfg} save={async (r) => ({ ok: true, region: r })} />);
    const select = (await screen.findByLabelText("AWS region")) as HTMLSelectElement;
    expect(select.value).toBe("eu-west-1");
    expect(screen.getByText(/US East \(N\. Virginia\)/)).toBeInTheDocument();
  });

  it("changes region, persists it, and tells the sidecar", async () => {
    const save = vi.fn(async (r: string) => ({ ok: true as const, region: r }));
    render(<RegionPicker load={async () => cfg} save={save} />);
    const select = await screen.findByLabelText("AWS region");
    fireEvent.change(select, { target: { value: "us-east-1" } });

    await waitFor(() => expect(save).toHaveBeenCalledWith("us-east-1"));
    expect(localStorage.getItem("mailpoppy.region")).toBe("us-east-1");
  });

  it("re-applies a saved region on mount", async () => {
    localStorage.setItem("mailpoppy.region", "us-west-2");
    const save = vi.fn(async (r: string) => ({ ok: true as const, region: r }));
    render(<RegionPicker load={async () => cfg} save={save} />);
    // saved (us-west-2) differs from sidecar default (eu-west-1) → re-applied.
    await waitFor(() => expect(save).toHaveBeenCalledWith("us-west-2"));
  });

  it("locks to the deployed region when a backend already exists", async () => {
    render(<RegionPicker lockedRegion="eu-west-1" load={async () => cfg} save={async (r) => ({ ok: true, region: r })} />);
    expect(await screen.findByText(/locked — already deployed here/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("AWS region")).toBeNull();
  });
});
