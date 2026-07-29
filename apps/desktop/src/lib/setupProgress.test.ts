import { describe, it, expect } from "vitest";
import { deriveResume, setupPhases } from "./setupProgress";

describe("deriveResume (resume from real AWS state)", () => {
  it("is a clean slate when nothing exists", () => {
    expect(deriveResume({ backendDeployed: false, domains: [] })).toEqual({ domain: "", step: "start", leftover: false });
  });

  it("a re-run pinned to a verified domain (presetDomain) resumes straight to the verified step", () => {
    expect(
      deriveResume({ backendDeployed: true, domains: ["acme.com"], presetDomain: "acme.com", dkim: "SUCCESS", verifiedForSending: true }),
    ).toEqual({ domain: "acme.com", step: "verified", leftover: false });
  });

  it("an already-verified domain with NO preset is a clean slate — opening setup means 'add another domain', not resume the finished one", () => {
    // Regression: previously this resumed the finished domain to its last step, which
    // stranded the user on the verified/test panel and blocked adding a SECOND domain.
    expect(
      deriveResume({ backendDeployed: true, domains: ["acme.com"], dkim: "SUCCESS", verifiedForSending: true }),
    ).toEqual({ domain: "", step: "start", leftover: false });
  });

  it("resumes a deployed-but-not-yet-verified domain to 'verifying' (so the poller resumes)", () => {
    expect(
      deriveResume({ backendDeployed: true, domains: ["acme.com"], dkim: "PENDING", verifiedForSending: false }),
    ).toEqual({ domain: "acme.com", step: "verifying", leftover: false });
  });

  it("does NOT resume an ADOPTED pre-existing domain to 'verifying' — its DKIM was never published by us, so polling would spin forever; route it through provision instead", () => {
    // The domain has an SES identity (created outside MailPoppy), so a status read
    // succeeds (dkim defined, not verified) — but it's absent from the provisioned
    // list, so we must NOT jump to the unwinnable verify poll.
    expect(
      deriveResume({
        backendDeployed: true,
        domains: ["managed.com"],
        presetDomain: "adopted.com",
        dkim: "NOT_STARTED",
        verifiedForSending: false,
      }),
    ).toEqual({ domain: "adopted.com", step: "start", leftover: false });
  });

  it("an adopted domain that is ALREADY verified elsewhere still isn't force-resumed to 'verified' (not in our provisioned list) — provision reconciles receiving", () => {
    expect(
      deriveResume({
        backendDeployed: true,
        domains: [],
        presetDomain: "verified-elsewhere.com",
        dkim: "SUCCESS",
        verifiedForSending: true,
      }),
    ).toEqual({ domain: "verified-elsewhere.com", step: "start", leftover: false });
  });

  it("flags a leftover when domain DNS exists but no backend is deployed", () => {
    expect(deriveResume({ backendDeployed: false, domains: ["mailpoppy.com"] })).toEqual({
      domain: "mailpoppy.com",
      step: "start",
      leftover: true,
    });
  });

  it("a preset (re-run) domain wins over discovery and is lower-cased", () => {
    const r = deriveResume({ backendDeployed: true, domains: ["other.com"], presetDomain: "Acme.COM", dkim: "SUCCESS", verifiedForSending: true });
    expect(r.domain).toBe("acme.com");
  });

  it("backend deployed but no domain yet → stays at 'start' (domain field editable)", () => {
    expect(deriveResume({ backendDeployed: true, domains: [] })).toEqual({ domain: "", step: "start", leftover: false });
  });

  it("backend + domain but no status signal → stays at 'start' (never guesses a step)", () => {
    expect(deriveResume({ backendDeployed: true, domains: ["acme.com"] })).toEqual({
      domain: "acme.com",
      step: "start",
      leftover: false,
    });
  });
});

describe("setupPhases (always-visible progress map)", () => {
  const base = { ready: true, backendDeployed: false, mailboxCount: 0 } as const;

  it("marks connect done and the rest upcoming on a fresh, connected start", () => {
    const p = setupPhases({ ...base, step: "start" });
    expect(p.map((x) => x.status)).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(p.every((x) => !x.busy)).toBe(true);
  });

  it("shows a live spinner on the deploy phase while deploying", () => {
    const deploy = setupPhases({ ...base, step: "deploying" }).find((x) => x.key === "deploy")!;
    expect(deploy).toMatchObject({ status: "current", busy: true });
    expect(deploy.detail).toMatch(/1–3 minutes/);
  });

  it("flags the DKIM verify phase as able to stall, with a spinner while verifying", () => {
    const verify = setupPhases({ ...base, step: "verifying", backendDeployed: true }).find((x) => x.key === "verify")!;
    expect(verify).toMatchObject({ status: "current", busy: true, canStall: true });
    expect(verify.detail).toMatch(/up to an hour/i);
  });

  it("counts created mailboxes as done", () => {
    const mb = setupPhases({ ...base, step: "verified", backendDeployed: true, mailboxCount: 2 }).find((x) => x.key === "mailbox")!;
    expect(mb).toMatchObject({ status: "done" });
    expect(mb.detail).toMatch(/2 mailboxes/);
  });

  it("treats a live-deployed backend as done even when the step state is stale", () => {
    const deploy = setupPhases({ ...base, step: "start", backendDeployed: true }).find((x) => x.key === "deploy")!;
    expect(deploy.status).toBe("done");
  });
});
