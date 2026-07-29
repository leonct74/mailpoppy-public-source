import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { SecurityInfo } from "./SecurityInfo";

afterEach(() => cleanup());

describe("SecurityInfo", () => {
  it("renders nothing when closed", () => {
    render(<SecurityInfo open={false} onClose={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists the key protections, marking GuardDuty as recommended", () => {
    render(<SecurityInfo open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: /email security/i })).toBeInTheDocument();
    expect(screen.getByText(/never leaves your AWS account/i)).toBeInTheDocument();
    expect(screen.getByText(/Virus & spam scanning/i)).toBeInTheDocument();
    expect(screen.getByText(/SPF · DKIM · DMARC/i)).toBeInTheDocument();
    expect(screen.getByText(/Per-mailbox isolation/i)).toBeInTheDocument();
    // The optional malware add-on is flagged Recommended.
    expect(screen.getByText(/Deep malware scanning/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Recommended/i).length).toBeGreaterThan(0);
  });

  it("closes via the close button", () => {
    const onClose = vi.fn();
    render(<SecurityInfo open onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
