import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AdminPrivacyNotice } from "./AdminPrivacyNotice";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("AdminPrivacyNotice", () => {
  it("explains the admin's responsibilities in a reassuring way", () => {
    render(<AdminPrivacyNotice />);
    expect(screen.getByText(/data controller/i)).toBeInTheDocument();
    // The #1 admin concern: credentials are never copied off the machine.
    expect(screen.getByText(/Your AWS keys never leave your computer/i)).toBeInTheDocument();
    expect(screen.getByText(/You choose where data lives/i)).toBeInTheDocument();
    expect(screen.getByText(/not legal advice/i)).toBeInTheDocument();
  });

  it("collapses and remembers the choice", () => {
    render(<AdminPrivacyNotice />);
    expect(screen.getByText(/data controller/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.queryByText(/data controller/i)).toBeNull();
    expect(localStorage.getItem("mailpoppy.privacyNoticeOpen")).toBe("false");
  });
});
