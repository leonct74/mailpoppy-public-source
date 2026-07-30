import { describe, it, expect } from "vitest";
import { buildHelperPrompt } from "./helper-prompt";
import { AGENT_MAILBOX, ALIASES, DEPLOY_OPTIONS, DOMAIN_STEP, MAILBOX_FIELDS } from "./setupCatalogue";

// The helper prompt IS the user's training, pasted into a foreign AI (AGENTS.md §9). Its one job
// is to never disagree with the forms: every option they render appears, in their own words, and
// nothing is invented. These tests fail the moment setupCatalogue.ts and the prompt drift apart —
// the only way a generated prompt can go wrong.
describe("the helper prompt", () => {
  it("carries the domain step, its wording and the DNS explanation", () => {
    const p = buildHelperPrompt();
    expect(p).toContain(DOMAIN_STEP.label);
    expect(p).toContain(DOMAIN_STEP.what);
    expect(p).toContain(DOMAIN_STEP.dnsStep);
    expect(p).toContain(DOMAIN_STEP.placeholder);
  });

  // The Route 53 requirement is what strands people mid-setup, so it must be stated before
  // anything else and named against the registrars users actually have.
  it("puts the Route 53 DNS-hosting prerequisite first and names the usual registrars", () => {
    const p = buildHelperPrompt();
    expect(p).toContain(DOMAIN_STEP.requirement);
    expect(p).toMatch(/HARD PREREQUISITE/);
    expect(p).toMatch(/GoDaddy, Namecheap, Cloudflare/);
    expect(p).toMatch(/the DNS move is step zero/);
  });

  it("warns that changing MX moves all of the domain's incoming mail", () => {
    const p = buildHelperPrompt();
    expect(p).toMatch(/moves ALL incoming mail for the domain to MailPoppy/);
    expect(p).toMatch(/spare domain or a subdomain/);
  });

  it("carries both deploy options with their labels and cautions verbatim", () => {
    const p = buildHelperPrompt();
    for (const o of DEPLOY_OPTIONS) {
      expect(p).toContain(`"${o.label}"`);
      expect(p).toContain(o.what);
      expect(p).toContain(o.caution);
    }
  });

  it("carries the mailbox fields, the password policy and the verification gate", () => {
    const p = buildHelperPrompt();
    expect(p).toContain(MAILBOX_FIELDS.address.label);
    expect(p).toContain(MAILBOX_FIELDS.address.what);
    expect(p).toContain(MAILBOX_FIELDS.password.policy);
    expect(p).toContain(MAILBOX_FIELDS.gate);
    expect(p).toContain(MAILBOX_FIELDS.existingMailWarning);
  });

  // Rule 1 cuts both ways: MailPoppy has no alias/catch-all UI, so the prompt must say so
  // rather than let an outside AI invent a field. Flip ALIASES.available when they ship.
  it("tells the truth about aliases instead of inventing a field", () => {
    const p = buildHelperPrompt();
    expect(ALIASES.available).toBe(false);
    expect(p).toContain(ALIASES.what);
    expect(p).toMatch(/no alias or catch-all feature today/);
    expect(p).toMatch(/Catch-all is deliberately NOT offered/);
  });

  // The sibling-promotion rule (AGENTS.md §9): name the sibling and the exact step, honestly
  // scoped. The founder's own rule for this control is prerequisite FIRST.
  it("names CrewPoppy, the exact step, and leads with the prerequisite", () => {
    const p = buildHelperPrompt();
    expect(p).toContain(AGENT_MAILBOX.prerequisiteFirst);
    expect(p).toContain(AGENT_MAILBOX.crossPoppyStep);
    expect(p).toContain(AGENT_MAILBOX.trigger);
    expect(p).toMatch(/This needs CrewPoppy/);
    // Honestly scoped: not an upsell for a setup that has no agent in it.
    expect(p).toMatch(/don't upsell me a second app/);
  });

  it("carries the non-negotiable agent-mailbox privacy warning", () => {
    expect(buildHelperPrompt()).toContain(AGENT_MAILBOX.privacyWarning);
  });

  it("states the product's hard rules as constraints", () => {
    const p = buildHelperPrompt();
    expect(p).toMatch(/Everything runs in MY AWS account/);
    expect(p).toMatch(/type the name to confirm/);
    expect(p).toMatch(/no trash or backup/);
    expect(p).toMatch(/Don't invent per-user pricing/);
    expect(p).toMatch(/40 MB/);
    expect(p).toMatch(/never suggest working around them/);
  });

  it("mentions the domain and region only when the app knows them", () => {
    const p = buildHelperPrompt({ domain: "acme.com", region: "eu-west-1" });
    expect(p).toContain("I am setting up acme.com");
    expect(p).toContain("My AWS region is eu-west-1");
    expect(buildHelperPrompt()).not.toContain("My AWS region is");
  });

  it("demands a fixed answer shape and allows a few questions first", () => {
    const p = buildHelperPrompt();
    expect(p).toMatch(/at most three short questions first/);
    expect(p).toMatch(/ANSWER IN EXACTLY THIS SHAPE/);
  });

  it("ends mid-sentence so the user's next words are the goal", () => {
    expect(buildHelperPrompt().endsWith("MY MAILBOX SETUP SHOULD: ")).toBe(true);
  });
});
