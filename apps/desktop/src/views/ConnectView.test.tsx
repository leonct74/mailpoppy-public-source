import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ConnectView } from "./ConnectView";

afterEach(() => cleanup());

describe("ConnectView", () => {
  it("saves a normalized config (trims trailing slash)", () => {
    const onSave = vi.fn();
    render(<ConnectView onSave={onSave} />);

    fireEvent.change(screen.getByPlaceholderText(/execute-api/), {
      target: { value: "https://abc.execute-api.eu-west-1.amazonaws.com/" },
    });
    fireEvent.change(screen.getByPlaceholderText("eu-west-1_xxxxxxxxx"), { target: { value: "eu-west-1_AB12" } });
    fireEvent.change(screen.getByPlaceholderText(/x{20}/), { target: { value: "client123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));

    expect(onSave).toHaveBeenCalledWith({
      apiBaseUrl: "https://abc.execute-api.eu-west-1.amazonaws.com",
      userPoolId: "eu-west-1_AB12",
      clientId: "client123",
      region: "eu-west-1",
    });
  });

  it("blocks save until all fields are filled", () => {
    const onSave = vi.fn();
    render(<ConnectView onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Save & continue" }));

    expect(screen.getByText(/All four values are required/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
