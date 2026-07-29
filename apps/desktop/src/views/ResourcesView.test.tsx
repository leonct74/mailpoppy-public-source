import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ResourcesView } from "./ResourcesView";
import type { Inventory } from "../lib/resources";

afterEach(() => cleanup());

const POPULATED: Inventory = {
  stackName: "MailpoppyMailStack",
  region: "eu-west-1",
  stackExists: true,
  resources: [
    { logicalId: "MailBucket", physicalId: "mailpoppy-bucket-abc", type: "AWS::S3::Bucket", status: "CREATE_COMPLETE" },
    { logicalId: "InboundProcessor", physicalId: "Mailpoppy-InboundProcessor-xyz", type: "AWS::Lambda::Function", status: "CREATE_COMPLETE" },
  ],
  ledger: [
    { ts: "2026-06-02T08:02:00.000Z", action: "created", service: "SES", resourceType: "EmailIdentity", name: "ollydigital.com", region: "eu-west-1" },
    { ts: "2026-06-02T08:30:00.000Z", action: "deleted", service: "Route 53", resourceType: "MX record", name: "ollydigital.com", region: "eu-west-1" },
  ],
};

describe("ResourcesView", () => {
  it("renders the stack inventory grouped by service with a console deep-link", async () => {
    const load = vi.fn(async () => POPULATED);
    render(<ResourcesView load={load} />);

    // resource physical names shown (proves both groups rendered)
    expect(await screen.findByText("mailpoppy-bucket-abc")).toBeInTheDocument();
    expect(screen.getByText("Mailpoppy-InboundProcessor-xyz")).toBeInTheDocument();
    // CloudFormation types shown in the Type column
    expect(screen.getByText("AWS::S3::Bucket")).toBeInTheDocument();
    expect(screen.getByText("AWS::Lambda::Function")).toBeInTheDocument();
    // console deep-links are rendered
    const links = screen.getAllByRole("link", { name: /Open/ });
    expect(links.length).toBeGreaterThan(0);
    expect(load).toHaveBeenCalledWith("MailpoppyMailStack");
  });

  it("shows the created/deleted change log for out-of-stack mutations", async () => {
    render(<ResourcesView load={vi.fn(async () => POPULATED)} />);

    expect(await screen.findByText("created")).toBeInTheDocument();
    expect(screen.getByText("deleted")).toBeInTheDocument();
    expect(screen.getByText(/EmailIdentity/)).toBeInTheDocument();
  });

  it("shows an empty state when no stack is deployed", async () => {
    const empty: Inventory = {
      stackName: "MailpoppyMailStack",
      region: "eu-west-1",
      stackExists: false,
      resources: [],
      ledger: [],
    };
    render(<ResourcesView load={vi.fn(async () => empty)} />);

    expect(await screen.findByText(/No MailPoppy backend is deployed/)).toBeInTheDocument();
  });

  it("surfaces a read error", async () => {
    const load = vi.fn(async () => {
      throw new Error("sidecar 500: boom");
    });
    render(<ResourcesView load={load} />);

    expect(await screen.findByText(/Couldn’t read your account/)).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  // The whole-backend "remove everything" control was intentionally removed: it is
  // too easy to trigger by accident and too blunt. Teardown is per-domain only
  // (each domain's workspace has its own scoped danger zone), so this read-only
  // inventory must never render a destructive control.
  it("has no whole-backend teardown control", async () => {
    render(<ResourcesView load={vi.fn(async () => POPULATED)} />);

    await screen.findByText("mailpoppy-bucket-abc");
    expect(screen.queryByRole("button", { name: "Toggle danger zone" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove everything" })).toBeNull();
    expect(screen.queryByText(/danger zone/i)).toBeNull();
  });
});
