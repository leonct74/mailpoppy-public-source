import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { AwsOnboarding } from "./AwsOnboarding";
import type { Readiness } from "../lib/awsCredentials";

afterEach(() => cleanup());

const readiness = (p: Partial<Readiness["credentials"]> = {}): Readiness => ({
  cli: { installed: true },
  credentials: { ok: true, arn: "arn:aws:iam::1:user/x", account: "1", ...p },
  permissions: { route53: "ok", ses: "ok", sesv2: "ok", s3: "ok" },
  ready: true,
});

/** Open the downranked "paste keys directly" disclosure. */
function openPaste() {
  fireEvent.click(screen.getByRole("button", { name: /paste your keys here/i }));
}

describe("AwsOnboarding", () => {
  it("guides a newcomer (account sign-up + scoped IAM keys) with working links", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} />);
    expect(screen.getByText(/Connect your AWS account/i)).toBeInTheDocument();
    expect(screen.getByText(/your own/i)).toBeInTheDocument();
    const signup = screen.getByRole("link", { name: /aws\.amazon\.com\/free/i });
    expect(signup).toHaveAttribute("href", "https://aws.amazon.com/free/");
    expect(screen.getByRole("link", { name: /IAM/i })).toBeInTheDocument();
    // Least-privilege guidance is front-and-centre, not buried.
    expect(screen.getByText(/never your account root/i)).toBeInTheDocument();
  });

  it("links BOTH the provisioning and deploy policies (deploy is required for the one-time backend creation)", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} />);
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => !!h);
    expect(hrefs.some((h) => h.endsWith("/mailpoppy-provisioning-policy.json"))).toBe(true);
    expect(hrefs.some((h) => h.endsWith("/mailpoppy-deploy-policy.json"))).toBe(true);
  });

  it("does not imply the user pays MailPoppy for AWS usage", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} />);
    // Cost is billed by AWS, not us — wording must not read as paying MailPoppy.
    expect(screen.queryByText(/MailPoppy's own\s+usage/i)).not.toBeInTheDocument();
    expect(screen.getByText(/billed by\s+AWS/i)).toBeInTheDocument();
    expect(screen.getByText(/You pay AWS directly; never us\./i)).toBeInTheDocument();
  });

  it("frames the CLI connect as step 3 (not a shortcut) and protects the secret", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} />);
    // No "Recommended" badge — it misread as a way to skip steps 1–2.
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
    expect(screen.getByText(/step 3/i)).toBeInTheDocument();
    expect(screen.getByText(/aws configure --profile mailpoppy/i)).toBeInTheDocument();
    expect(screen.getByText(/never enters/i)).toBeInTheDocument();
  });

  it("'Check connection' re-runs the environment probe (the CLI/SSO path)", () => {
    const onRecheck = vi.fn();
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={onRecheck} />);
    fireEvent.click(screen.getByRole("button", { name: /check connection/i }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });

  it("hides the paste form by default and reveals it (with an honest trade-off note) on demand", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} />);
    expect(screen.queryByLabelText("Access Key ID")).not.toBeInTheDocument();
    openPaste();
    expect(screen.getByLabelText("Access Key ID")).toBeInTheDocument();
    expect(screen.getByText(/pass through MailPoppy/i)).toBeInTheDocument();
  });

  it("disables Connect until both keys are entered, then submits trimmed values", async () => {
    const submit = vi.fn(async () => readiness());
    const onResult = vi.fn();
    render(<AwsOnboarding onResult={onResult} onRecheck={vi.fn()} submit={submit} />);
    openPaste();

    const connect = screen.getByRole("button", { name: /^connect$/i });
    expect(connect).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Access Key ID"), { target: { value: "AKIAEXAMPLE" } });
    fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "secretvalue" } });
    expect(connect).not.toBeDisabled();

    fireEvent.click(connect);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secretvalue",
      sessionToken: undefined,
    });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(readiness()));
  });

  it("surfaces AWS rejecting the keys (but still reports the result up)", async () => {
    const bad = readiness({ ok: false, error: "InvalidClientTokenId" });
    const onResult = vi.fn();
    render(<AwsOnboarding onResult={onResult} onRecheck={vi.fn()} submit={vi.fn(async () => bad)} />);
    openPaste();
    fireEvent.change(screen.getByLabelText("Access Key ID"), { target: { value: "AKIA" } });
    fireEvent.change(screen.getByLabelText("Secret Access Key"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    await waitFor(() => expect(screen.getByText(/didn't accept those keys/i)).toBeInTheDocument());
    expect(screen.getByText(/InvalidClientTokenId/)).toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(bad);
  });

  it("prompts to install the AWS CLI when it isn't detected", () => {
    render(<AwsOnboarding onResult={vi.fn()} onRecheck={vi.fn()} cliInstalled={false} />);
    expect(screen.getByRole("link", { name: /AWS CLI/i })).toHaveAttribute(
      "href",
      "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
    );
  });
});
