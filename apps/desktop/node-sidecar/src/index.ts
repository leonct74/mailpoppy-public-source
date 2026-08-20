/**
 * Local provisioning sidecar. Exposes the (desktop-admin-only) provisioning
 * engine to the React frontend over localhost HTTP. Uses the admin's AWS
 * credential chain (AWS_PROFILE / SSO). Never bundled into the mobile app.
 */
import Fastify from "fastify";
import { randomUUID } from "node:crypto";


import { join } from "node:path";
import * as prov from "./provisioning";
import * as migration from "./migration";
import * as mailboxImport from "./mailboxImport";
import { readLedger } from "./ledger";
import { getOrCreateBuyerId } from "./buyerId";
import { writeMailpoppyProfile, mailpoppyProfileExists, MAILPOPPY_PROFILE } from "./awsProfile";
import { checkCapabilities } from "./capabilities";
import { beginBrokerConnect, refreshBrokerStatus, disconnectBroker, brokerRegion, brokerPort, brokerDataDir, isContainerMode } from "./agentspoppyBroker";
import { initStorage } from "./storage";
import { SES_INBOUND_REGIONS } from "@mailpoppy/core";

// 25 MiB body limit (Fastify defaults to 1 MiB): the bulk-mailbox importer POSTs
// the chosen spreadsheet as base64 JSON, and base64 inflates the bytes by ~33%.
// A spreadsheet of mailboxes is tiny, but this leaves generous headroom.
const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });

// Before any route: point the ledger + buyer-id at the host's data folder and carry a
// pre-0.1.16 ~/.mailpoppy across (one-time, idempotent, best-effort — see storage.ts).
// Standalone (no bootstrap) keeps using ~/.mailpoppy, unchanged.
const storage = initStorage(brokerDataDir());
if (storage.migrated.length) {
  app.log.info(`moved ${storage.migrated.join(" + ")} from ~/.mailpoppy into ${storage.home}`);
}

// CORS allowlist. The sidecar binds 127.0.0.1 only, but we still scope CORS to
// known origins rather than reflecting any origin — a random web page must not be
// able to drive AWS provisioning via the user's browser.
//   - http://localhost:1420 / 127.0.0.1:1420 → Vite dev server
//   - tauri://localhost                       → packaged macOS/Linux webview
//   - https://tauri.localhost                 → packaged Windows (WebView2) webview
const ALLOWED_ORIGINS = new Set([
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "https://tauri.localhost",
]);
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
    reply.header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    reply.header("access-control-allow-headers", "content-type, authorization");
  }
  // Answer CORS preflight (the POST /provision call triggers one).
  if (req.method === "OPTIONS") {
    return reply.code(204).send();
  }
});

// Map low-level connectivity failures bubbling up from the AWS SDK (machine
// offline / DNS unavailable) to a clear, actionable 503 instead of a raw 500
// with a cryptic "getaddrinfo ENOTFOUND route53.amazonaws.com". Everything else
// keeps Fastify's default shape (statusCode + message) so existing error
// handling on the client is unchanged.
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND", // DNS lookup failed (offline / DNS down)
  "EAI_AGAIN", // DNS temporary failure
  "ETIMEDOUT", // connection timed out
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EHOSTDOWN",
]);
function networkErrorCode(err: unknown): string | undefined {
  // The SDK may surface the system error directly or wrap it under `cause`.
  const e = err as { code?: string; cause?: { code?: string } };
  if (e?.code && NETWORK_ERROR_CODES.has(e.code)) return e.code;
  if (e?.cause?.code && NETWORK_ERROR_CODES.has(e.cause.code)) return e.cause.code;
  return undefined;
}

// Turn an opaque error into something the user can act on. The most common one
// is a failed credential subprocess — the AWS SDK runs your profile's
// `credential_process` / SSO helper, and when that session has expired the
// child exits non-zero with the cryptic message "Command failed".
function describeError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const msg = e?.message ?? String(err);
  const credLike =
    e?.name === "CredentialsProviderError" ||
    /\bCommand failed\b/i.test(msg) ||
    /could not load credentials|credential[_ -]?process|\bSSO\b|ExpiredToken|security token.*(expired|invalid)/i.test(msg);
  if (credLike) {
    // In the AgentsPoppy container credentials come from the broker connection — no local
    // re-auth exists (and once confined, no home-directory credential source is even
    // readable), so pointing at `aws sso login` would be a dead end.
    return isContainerMode()
      ? "Couldn't get your AWS credentials from AgentsPoppy — the connection may be paused or expired. Open AgentsPoppy, check MailPoppy's connection is active, then try again."
      : "Couldn't get your AWS credentials — your session has probably expired. Re-authenticate (e.g. `aws sso login`, or refresh whatever your profile's credential_process uses), then restart Mailpoppy and try again.";
  }
  return msg;
}
app.setErrorHandler((err, _req, reply) => {
  const netCode = networkErrorCode(err);
  if (netCode) {
    app.log.warn({ err, code: netCode }, "network failure reaching AWS");
    return reply.code(503).send({
      ok: false,
      code: netCode,
      error: "Network",
      message: "Couldn't reach AWS — check your internet connection and try again.",
    });
  }
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
  app.log.error({ err }, "request failed");
  return reply.code(statusCode).send({
    ok: false,
    code: (err as { code?: string }).code,
    error: err.name ?? "Internal Server Error",
    message: describeError(err),
  });
});

// The active AWS region for provisioning. Starts from the env, but the admin can
// change it from the wizard (data-residency) BEFORE deploying — the frontend
// re-applies its saved choice on launch. Route53 stays global (pinned in clients()).
// In container mode the AgentsPoppy host resolves the region for the connection and
// injects it via the bootstrap; honour that over the env default.
let currentRegion = brokerRegion() ?? process.env.AWS_REGION ?? "eu-west-1";

// The active credential profile. An explicit AWS_PROFILE (power users) always
// wins; otherwise, if a [mailpoppy] profile exists in ~/.aws/credentials (written
// either by the in-app key entry or by `aws configure --profile mailpoppy`), we
// resolve from it. undefined → the SDK's default provider chain (env/default/SSO).
function resolveProfile(): string | undefined {
  return process.env.AWS_PROFILE ?? (mailpoppyProfileExists() ? MAILPOPPY_PROFILE : undefined);
}
let currentProfile: string | undefined = resolveProfile();

const ctx = (): prov.AwsContext => ({
  region: currentRegion,
  profile: currentProfile,
});

app.get("/health", async () => ({ ok: true }));

// One-shot local file handoff. The Tauri webview (WKWebView) can't trigger a
// blob/`<a download>` save, so for *encrypted* attachments — whose plaintext is
// decrypted in the webview and never exists on S3 to hand to the OS opener — the
// client POSTs the decrypted bytes here, gets a single-use token, and opens the
// matching GET URL through the system browser (which downloads it cleanly via
// Content-Disposition). Held in memory only, on loopback, evicted on first fetch
// or after a short TTL — the plaintext never touches disk in the sidecar.
type PendingDownload = { filename: string; contentType: string; buf: Buffer; timer: NodeJS.Timeout };
const pendingDownloads = new Map<string, PendingDownload>();
const LOCAL_DOWNLOAD_TTL_MS = 60_000;

app.post("/local-download", async (req, reply) => {
  const { filename, contentType, dataB64 } = (req.body ?? {}) as {
    filename?: string;
    contentType?: string;
    dataB64?: string;
  };
  if (typeof dataB64 !== "string" || !dataB64) {
    return reply.code(400).send({ error: "dataB64 is required" });
  }
  const token = randomUUID();
  const timer = setTimeout(() => pendingDownloads.delete(token), LOCAL_DOWNLOAD_TTL_MS);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive on this timer
  pendingDownloads.set(token, {
    filename: filename || "attachment",
    contentType: contentType || "application/octet-stream",
    buf: Buffer.from(dataB64, "base64"),
    timer,
  });
  return reply.send({ token });
});

app.get("/local-download/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  const item = pendingDownloads.get(token);
  if (!item) return reply.code(404).send("Download expired or already used.");
  clearTimeout(item.timer);
  pendingDownloads.delete(token); // single-use
  // Quote-escape the filename for the Content-Disposition header (and provide an
  // ASCII-safe fallback alongside the UTF-8 form for non-Latin names).
  const safe = item.filename.replace(/["\\\r\n]/g, "_");
  return reply
    .header("content-type", item.contentType)
    .header("content-disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`)
    .header("content-length", String(item.buf.length))
    .send(item.buf);
});

// (POST /local-download/save — the silent write into ~/Downloads — was removed in 0.1.16:
// the backend is being confined and may not touch the user's folders. Every save now goes
// through the one-shot token above; the system browser does the writing.)

// The active region + the regions where SES inbound is supported (the choices).
app.get("/config/region", async () => ({ region: currentRegion, available: SES_INBOUND_REGIONS }));

// Set the active region (must be an SES-inbound region). Applies to subsequent
// provisioning/deploy calls; can't move an already-deployed stack.
app.post("/config/region", async (req, reply) => {
  const b = (req.body ?? {}) as { region?: string };
  if (!b.region || !(SES_INBOUND_REGIONS as readonly string[]).includes(b.region)) {
    return reply.code(400).send({ ok: false, error: `region must be one of: ${SES_INBOUND_REGIONS.join(", ")}` });
  }
  currentRegion = b.region;
  return { ok: true, region: currentRegion };
});

// This machine's durable, opaque AgentsPoppy buyer id — the capability that later opens the buyer's
// Stripe billing portal. Persisted in ~/.mailpoppy so it survives updates/reinstalls and is shared
// between the standalone webview and the AgentsPoppy container (webview localStorage is neither).
// An optional `seed` lets the frontend hand up an id it minted earlier in localStorage so a buyer who
// already paid under it keeps their billing link. See node-sidecar/src/buyerId.ts.
app.post("/commerce/buyer-id", async (req) => {
  const { seed } = (req.body ?? {}) as { seed?: string };
  return { buyerId: await getOrCreateBuyerId(seed) };
});

// Step 0: is this environment able to provision at all? (credentials + per-service
// permission probes + optional CLI detection). Run before anything mutating.
// Re-detect the profile first, so a `mailpoppy` profile created via the CLI *after*
// the sidecar started (the recommended onboarding path) is picked up on "Check
// connection" without restarting — but never downgrade a profile already in use.
app.get("/aws/readiness", async () => {
  if (!currentProfile) currentProfile = resolveProfile();
  return prov.checkReadiness(ctx());
});

// Live "permissions lights": which capability tiers (operate / deploy) the active
// identity actually has, via iam:SimulatePrincipalPolicy (read-only, no side effects).
app.get("/aws/capabilities", async () => {
  if (!currentProfile) currentProfile = resolveProfile();
  return checkCapabilities(ctx());
});

// In-app credential entry (onboarding for users with no CLI/profile set up).
// Persists the pasted keys as a `[mailpoppy]` profile in ~/.aws/credentials
// (0600, other profiles untouched), switches the sidecar to use it, then returns
// a fresh readiness so the UI can confirm the keys actually work. Bad keys aren't
// an error — readiness will simply show credentials not ok, which the UI surfaces.
app.post("/aws/credentials", async (req, reply) => {
  // In the AgentsPoppy container credentials come from the broker connection, and the
  // confined backend can't write ~/.aws anyway — refuse plainly instead of dying on a
  // denied write halfway through.
  if (isContainerMode()) {
    return reply.code(400).send({
      ok: false,
      error: "Inside AgentsPoppy, MailPoppy uses the AWS connection you approved there — there are no keys to paste. Manage access in AgentsPoppy instead.",
    });
  }
  const b = (req.body ?? {}) as { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
  if (!b.accessKeyId?.trim() || !b.secretAccessKey?.trim()) {
    return reply.code(400).send({ ok: false, error: "Both an Access Key ID and a Secret Access Key are required." });
  }
  try {
    writeMailpoppyProfile({
      accessKeyId: b.accessKeyId,
      secretAccessKey: b.secretAccessKey,
      sessionToken: b.sessionToken,
    });
  } catch (e) {
    return reply.code(500).send({ ok: false, error: (e as Error).message });
  }
  currentProfile = MAILPOPPY_PROFILE; // use the just-written keys from now on
  return prov.checkReadiness(ctx());
});

// --- AgentsPoppy broker (opt-in): get AWS credentials from a local AgentsPoppy ---
// instead of the ~/.aws profile, so AgentsPoppy can govern + tear down what we
// deploy. Connect → user approves in AgentsPoppy → poll status until "active".

// Request (or reuse) MailPoppy's connection on the local AgentsPoppy broker.
app.post("/agentspoppy/connect", async (req, reply) => {
  const b = (req.body ?? {}) as { accountId?: string };
  try {
    return await beginBrokerConnect({ accountId: b.accountId });
  } catch (e) {
    return reply.code(502).send({ ok: false, error: (e as Error).message });
  }
});

// Poll the connection's approval status (UI shows "approve in AgentsPoppy…").
app.get("/agentspoppy/status", async (_req, reply) => {
  try {
    return await refreshBrokerStatus();
  } catch (e) {
    return reply.code(502).send({ ok: false, error: (e as Error).message });
  }
});

// Stop using broker credentials (back to the local profile).
app.post("/agentspoppy/disconnect", async () => {
  disconnectBroker();
  return { ok: true };
});

// Read-only: confirm credentials + that the domain's zone exists (wizard step 1).
app.get("/aws/preflight/:domain", async (req) => {
  const domain = (req.params as { domain: string }).domain;
  const c = ctx();
  const [accountId, zoneId] = await Promise.all([
    prov.getAccountId(c),
    prov.findHostedZoneId(c, domain),
  ]);
  return { accountId, zoneId, region: c.region };
});

// Mutating: set up the domain's MAIL identity + DNS only. The S3 bucket and the
// SES receipt rule set now belong to the deployed backend stack (POST
// /deploy/backend), which avoids two parallel buckets/rule-sets fighting over the
// single active receipt rule set. So this just: verify-domain DKIM + publish the
// DKIM CNAMEs / MX / DMARC records. The UI must confirm before calling this.
app.post("/provision/:domain", async (req) => {
  const domain = (req.params as { domain: string }).domain;
  const c = ctx();
  const zoneId = await prov.findHostedZoneId(c, domain);
  const dkimTokens = await prov.createIdentityGetDkimTokens(c, domain);
  const changeId = await prov.applyDnsRecords(c, {
    zoneId,
    domain,
    dkimTokens,
    dmarcRua: `postmaster@${domain}`,
  });
  return { ok: true, domain, zoneId, dkimTokens, changeId };
});

// Read-only: the resource transparency inventory (DESIGN §14.1) — the deployed
// stack's resources straight from CloudFormation, plus the local provisioning
// ledger of out-of-stack mutations (Route53/SES identity/rule-set activation).
app.get("/aws/inventory/:stackName", async (req) => {
  const stackName = (req.params as { stackName: string }).stackName;
  const c = ctx();
  const [stack, ledger] = await Promise.all([prov.listStackResources(c, stackName), readLedger()]);
  return { stackName, region: c.region, stackExists: stack.stackExists, resources: stack.resources, ledger };
});

// Read-only cross-region discovery: in which SES-inbound region does the backend
// stack live, and what SES domains exist in each. This is how the app re-finds
// everything after a reinstall / cleared local state — the stack and all data live
// in the user's OWN AWS, so we just locate the region holding them — and how it
// surfaces pre-existing domains the user created outside the app. Re-detect the
// profile first (same as readiness) so a freshly-added `mailpoppy` profile is used.
app.get("/aws/discover", async () => {
  if (!currentProfile) currentProfile = resolveProfile();
  const c = ctx();
  const regions = await prov.discoverRegions(c);
  const stackRegion = regions.find((r) => r.stackExists)?.region ?? null;
  // If no stack anywhere, fall back to the single region that actually holds SES
  // domains, so a pre-existing-domains-only account still snaps to the right place.
  const withDomains = regions.filter((r) => r.domains.length > 0);
  const domainRegion = withDomains.length === 1 ? (withDomains[0]?.region ?? null) : null;
  return { currentRegion: c.region, stackRegion, domainRegion, regions };
});

// Read-only: every SES domain identity in the ACTIVE region, INCLUDING domains not
// created by MailPoppy. The dashboard merges this with the managed domains so the
// admin sees their whole cloud, not only what this app provisioned.
app.get("/aws/ses-domains", async () => {
  if (!currentProfile) currentProfile = resolveProfile();
  return { region: currentRegion, domains: await prov.listSesDomains(ctx()) };
});

app.get("/provision/:domain/status", async (req) => {
  const domain = (req.params as { domain: string }).domain;
  return prov.getIdentityStatus(ctx(), domain);
});

// Send the in-app deliverability self-test (mirrors Phase 0 step 7). Requires the
// domain's DKIM to be verified first (the UI gates this behind the status poll).
app.post("/provision/:domain/test", async (req, reply) => {
  const domain = (req.params as { domain: string }).domain;
  const to = (req.body as { to?: string } | undefined)?.to;
  if (!to) return reply.code(400).send({ ok: false, error: "missing 'to' recipient" });
  const messageId = await prov.sendTest(ctx(), {
    from: `hello@${domain}`,
    to,
    subject: "Mailpoppy deliverability test",
    text: "If you can read this in your inbox (not spam), Mailpoppy sending works. Check 'Show original' for SPF/DKIM/DMARC = PASS.",
    html: "<p>If you can read this in your <b>inbox</b> (not spam), Mailpoppy sending works.</p><p>Open <b>Show original</b> and confirm <b>SPF=PASS, DKIM=PASS, DMARC=PASS</b>.</p>",
  });
  return { ok: true, messageId };
});

// ---- Phase 4: migrate existing mail (WorkMail / any IMAP) -------------------

// Read-only: verify the IMAP credentials and enumerate folders + message counts
// (with the Mailpoppy folder each maps to) so the UI can preview the import.
app.post("/migrate/imap/test", async (req, reply) => {
  const b = (req.body ?? {}) as Partial<migration.ImapSource>;
  if (!b.host || !b.user || !b.password) {
    return reply.code(400).send({ ok: false, error: "host, user and password are required" });
  }
  try {
    return await migration.testImap({
      host: b.host,
      port: b.port,
      secure: b.secure,
      user: b.user,
      password: b.password,
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: describeError(err) });
  }
});

// Mutating: pull mail from IMAP into the deployed backend's S3 + DynamoDB. The
// UI confirms before calling this. Bucket/table are resolved from the stack
// Outputs unless explicitly provided.
app.post("/migrate/imap/run", async (req, reply) => {
  const b = (req.body ?? {}) as {
    source?: migration.ImapSource;
    mailbox?: string;
    stackName?: string;
    bucket?: string;
    indexTable?: string;
    folders?: string[];
    maxMessages?: number;
    dryRun?: boolean;
  };
  if (!b.source?.host || !b.source?.user || !b.source?.password) {
    return reply.code(400).send({ ok: false, error: "source.host, source.user, source.password required" });
  }
  if (!b.mailbox) return reply.code(400).send({ ok: false, error: "mailbox (destination) is required" });

  const c = ctx();
  let bucket = b.bucket;
  let indexTable = b.indexTable;
  if (!bucket || !indexTable) {
    const outputs = await prov.getStackOutputs(c, b.stackName ?? "MailpoppyMailStack");
    bucket = bucket ?? outputs.MailBucketName;
    indexTable = indexTable ?? outputs.IndexTableName;
  }
  if (!bucket || !indexTable) {
    return reply.code(400).send({ ok: false, error: "could not resolve MailBucketName / IndexTableName from the stack" });
  }

  try {
    const summary = await migration.migrate(c, {
      source: b.source,
      target: { mailbox: b.mailbox, bucket, indexTable },
      folders: b.folders,
      maxMessages: b.maxMessages,
      dryRun: b.dryRun,
    });
    return { ok: true, ...summary };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: describeError(err) });
  }
});

// ---- Mailboxes (Cognito users in the deployed backend's user pool) ----

const NO_BACKEND =
  'No deployed Mailpoppy backend was found yet. Set up a domain and use the in-app "Deploy backend" step to create it, then add mailboxes.';

async function resolveBackend(stackName: string) {
  const c = ctx();
  let outputs: Record<string, string>;
  try {
    outputs = await prov.getStackOutputs(c, stackName);
  } catch (e) {
    if (/does not exist|ValidationError/i.test((e as Error).message ?? "")) return null;
    throw e;
  }
  if (!outputs.UserPoolId) return null;
  return {
    region: c.region,
    userPoolId: outputs.UserPoolId,
    clientId: outputs.UserPoolClientId,
    apiBaseUrl: outputs.ApiBaseUrl,
  };
}

// List existing mailboxes in the backend's user pool.
app.get("/mailbox/list/:stackName", async (req, reply) => {
  const stackName = (req.params as { stackName: string }).stackName;
  const backend = await resolveBackend(stackName);
  if (!backend) return reply.code(404).send({ ok: false, error: NO_BACKEND });
  const mailboxes = await prov.listMailboxes(ctx(), backend.userPoolId);
  return { ok: true, ...backend, mailboxes };
});

// Create a mailbox (Cognito user + permanent password). The UI confirms first.
app.post("/mailbox/create", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; email?: string; password?: string };
  if (!b.email || !b.password) {
    return reply.code(400).send({ ok: false, error: "email and password are required" });
  }
  const backend = await resolveBackend(b.stackName ?? "MailpoppyMailStack");
  if (!backend) return reply.code(404).send({ ok: false, error: NO_BACKEND });
  try {
    const mailbox = await prov.createMailbox(ctx(), {
      userPoolId: backend.userPoolId,
      email: b.email,
      password: b.password,
    });
    return { ok: true, mailbox, ...backend };
  } catch (err) {
    return reply.code(400).send({ ok: false, error: (err as Error).message });
  }
});

// Delete a mailbox: its Cognito sign-in user AND all of its stored mail
// (S3 + DynamoDB). Irreversible — the UI gates this behind a typed confirmation.
app.post("/mailbox/delete", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; email?: string };
  if (!b.email) return reply.code(400).send({ ok: false, error: "email is required" });
  const stackName = b.stackName ?? "MailpoppyMailStack";
  const backend = await resolveBackend(stackName);
  if (!backend) return reply.code(404).send({ ok: false, error: NO_BACKEND });
  try {
    const result = await prov.deleteMailbox(ctx(), { stackName, email: b.email });
    return { ok: true, ...result };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Admin-reset a mailbox's sign-in password (e.g. recover a departed employee's
// mailbox). The password is taken from the request body and never logged.
app.post("/mailbox/reset-password", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; email?: string; password?: string };
  if (!b.email || !b.password) {
    return reply.code(400).send({ ok: false, error: "email and password are required" });
  }
  const backend = await resolveBackend(b.stackName ?? "MailpoppyMailStack");
  if (!backend) return reply.code(404).send({ ok: false, error: NO_BACKEND });
  try {
    return await prov.resetMailboxPassword(ctx(), {
      userPoolId: backend.userPoolId,
      email: b.email,
      password: b.password,
    });
  } catch (err) {
    return reply.code(400).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Mailbox storage quotas (admin) ----

// Read a mailbox's current storage usage + quota (for "X% of Y used").
app.get("/mailbox/storage/:stackName/:email", async (req, reply) => {
  const p = req.params as { stackName: string; email: string };
  try {
    return await prov.getMailboxStorage(ctx(), { stackName: p.stackName, email: decodeURIComponent(p.email) });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Set or clear (quotaBytes: null) a mailbox's storage quota.
app.post("/mailbox/quota", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; email?: string; quotaBytes?: number | null };
  if (!b.email) return reply.code(400).send({ ok: false, error: "email is required" });
  try {
    return await prov.setMailboxQuota(ctx(), {
      stackName: b.stackName,
      email: b.email,
      quotaBytes: b.quotaBytes ?? null,
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Agent-owned mailboxes (the CrewPoppy bridge) ----

// Whether a mailbox's inbound mail is handed to the admin's CrewPoppy agents.
app.get("/mailbox/agent/:stackName/:email", async (req, reply) => {
  const p = req.params as { stackName: string; email: string };
  try {
    return await prov.getAgentOwned(ctx(), { stackName: p.stackName, email: decodeURIComponent(p.email) });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Flag or unflag a mailbox as agent-owned. The desktop UI shows the privacy
// disclosure BEFORE enabling (an agent-owned mailbox's mail goes to an AI agent
// in plain text); the default is always off.
app.post("/mailbox/agent", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; email?: string; agentOwned?: boolean };
  if (!b.email) return reply.code(400).send({ ok: false, error: "email is required" });
  if (typeof b.agentOwned !== "boolean") {
    return reply.code(400).send({ ok: false, error: "agentOwned (true/false) is required" });
  }
  try {
    return await prov.setAgentOwned(ctx(), { stackName: b.stackName, email: b.email, agentOwned: b.agentOwned });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Bulk mailbox import (parse a spreadsheet; the UI runs create/migrate) ----

// Read-only: parse + validate an uploaded .xlsx/.csv (base64 in the body) into a
// per-row import plan for one domain. No mailboxes are created here — the UI
// shows the plan as a preview, then drives the existing /mailbox/create and
// /migrate/imap/run routes per row, so it can show progress and survive a bad row.
app.post("/mailbox/import/parse", async (req, reply) => {
  const b = (req.body ?? {}) as { domain?: string; fileBase64?: string; filename?: string };
  if (!b.domain) return reply.code(400).send({ ok: false, error: "domain is required" });
  if (!b.fileBase64) return reply.code(400).send({ ok: false, error: "fileBase64 (the spreadsheet) is required" });
  let buffer: Buffer;
  try {
    buffer = Buffer.from(b.fileBase64, "base64");
  } catch {
    return reply.code(400).send({ ok: false, error: "the uploaded file could not be decoded" });
  }
  try {
    const plan = await mailboxImport.planFromBuffer(buffer, b.domain, b.filename);
    return { ok: true, plan };
  } catch (err) {
    // Malformed/unreadable spreadsheet or no recognizable columns → 400 (client
    // error), with the user-facing message from core where we set one.
    return reply.code(400).send({ ok: false, error: (err as Error).message });
  }
});

// Generate the friendly .xlsx template and stage it under a one-shot download token
// (same in-memory path as attachment saves). The webview can't save a file itself, and
// since 0.1.16 neither can this sidecar — the backend is being confined away from the
// user's folders — so the SYSTEM BROWSER fetches the token URL and saves it.
app.post("/mailbox/import/template", async (req, reply) => {
  const b = (req.body ?? {}) as { domain?: string };
  if (!b.domain) return reply.code(400).send({ ok: false, error: "domain is required" });
  try {
    const { filename, buf } = await mailboxImport.buildTemplate(b.domain);
    const token = randomUUID();
    const timer = setTimeout(() => pendingDownloads.delete(token), LOCAL_DOWNLOAD_TTL_MS);
    if (typeof timer.unref === "function") timer.unref();
    pendingDownloads.set(token, {
      filename,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buf,
      timer,
    });
    return { ok: true, token, filename };
  } catch (err) {
    return reply.code(500).send({ ok: false, error: (err as Error).message });
  }
});

// ---- One-click backend deploy (CloudFormation, no terminal/cdk for the user) ----

// Mutating: upload the embedded template + Lambda code and Create/UpdateStack.
// The UI confirms first. Returns immediately; poll the status route.
app.post("/deploy/backend", async (req, reply) => {
  const b = (req.body ?? {}) as {
    domain?: string;
    stackName?: string;
    enableMalwareProtection?: boolean;
    enableEncryption?: boolean;
  };
  if (!b.domain) return reply.code(400).send({ ok: false, error: "domain is required" });
  try {
    return await prov.deployBackend(ctx(), {
      domain: b.domain,
      stackName: b.stackName,
      enableMalwareProtection: b.enableMalwareProtection,
      enableEncryption: b.enableEncryption,
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Poll deploy progress; activates the SES rule set once complete.
app.get("/deploy/backend/:stackName/status", async (req) => {
  const stackName = (req.params as { stackName: string }).stackName;
  return prov.getDeployStatus(ctx(), stackName);
});

// Read-only: does THIS app build carry newer backend code than what's deployed?
app.get("/deploy/backend/version", async (_req, reply) => {
  try {
    return await prov.getBackendVersion(ctx());
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Mutating: update the deployed backend to this build's Lambda code (code only —
// every other setting is kept via UsePreviousValue). Returns immediately; poll status.
app.post("/deploy/backend/update", async (_req, reply) => {
  try {
    return await prov.updateBackendCode(ctx());
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- SES sandbox / production access (DESIGN §13) ----

// Read-only: sandbox vs production, review status of any in-flight request, send quota.
app.get("/ses/account", async (_req, reply) => {
  try {
    return await prov.getSesAccount(ctx());
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Read-only: per-domain "sending health" overview — an account-wide header
// (paused/quota + the authoritative all-domains SES bounce/complaint totals) plus
// one row per domain (sends from stored Sent copies, bounces/complaints from the
// STAT# counters, and the do-not-send count attributed to that domain).
app.get("/ses/deliverability/:stackName", async (req, reply) => {
  const { stackName } = req.params as { stackName: string };
  try {
    return await prov.getDeliverabilityOverview(ctx(), { stackName });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Mutating: submit a production-access (sandbox-exit) request to AWS (opens a
// Support case AWS reviews, ~24h). The UI confirms first. 400 on a bad request
// (validated in core) so the user gets a clear message, not a raw SES error.
app.post("/ses/production-access", async (req, reply) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    return await prov.requestProductionAccess(ctx(), b as unknown as Parameters<typeof prov.requestProductionAccess>[1]);
  } catch (err) {
    return reply.code(400).send({ ok: false, error: (err as Error).message });
  }
});

// Read-only: the domain's custom MAIL FROM configuration + verification status.
app.get("/ses/mail-from/:domain", async (req, reply) => {
  const domain = (req.params as { domain: string }).domain;
  try {
    return await prov.getMailFromStatus(ctx(), domain);
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Mutating: configure a custom MAIL FROM subdomain (SPF alignment) — points the
// SES identity at it and writes the feedback MX + SPF TXT to Route53. The UI
// confirms first (it changes DNS).
app.post("/ses/mail-from", async (req, reply) => {
  const b = (req.body ?? {}) as { domain?: string; subdomain?: string };
  if (!b.domain) return reply.code(400).send({ ok: false, error: "domain is required" });
  try {
    return await prov.setupMailFrom(ctx(), { domain: b.domain, subdomain: b.subdomain });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Spam / auth policy (allow-block lists + per-verdict actions) ----

// Read a mail-filtering policy (defaults if never set). `?domain=` reads a
// per-domain override; omitted reads the deployment-wide default.
app.get("/policy/spam/:stackName", async (req, reply) => {
  const stackName = (req.params as { stackName: string }).stackName;
  const scope = (req.query as { domain?: string }).domain;
  try {
    return await prov.getSpamPolicy(ctx(), { stackName, scope });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Update a mail-filtering policy (normalized server-side). `domain` in the body
// writes a per-domain override; omitted writes the deployment-wide default.
app.post("/policy/spam", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; policy?: unknown; domain?: string };
  if (!b.policy || typeof b.policy !== "object") {
    return reply.code(400).send({ ok: false, error: "policy is required" });
  }
  try {
    return await prov.setSpamPolicy(ctx(), {
      stackName: b.stackName,
      scope: b.domain,
      policy: b.policy as Parameters<typeof prov.setSpamPolicy>[1]["policy"],
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Retention (how long mail is kept) ----

app.get("/policy/retention/:stackName", async (req, reply) => {
  const stackName = (req.params as { stackName: string }).stackName;
  const scope = (req.query as { domain?: string }).domain;
  try {
    return await prov.getRetention(ctx(), { stackName, scope });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

app.post("/policy/retention", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; retention?: unknown; domain?: string };
  if (!b.retention || typeof b.retention !== "object") {
    return reply.code(400).send({ ok: false, error: "retention is required" });
  }
  try {
    return await prov.setRetention(ctx(), {
      stackName: b.stackName,
      scope: b.domain,
      retention: b.retention as Parameters<typeof prov.setRetention>[1]["retention"],
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Send settings (max outgoing attachment size) ----

app.get("/send/settings/:stackName", async (req, reply) => {
  const stackName = (req.params as { stackName: string }).stackName;
  try {
    return await prov.getSendSettings(ctx(), { stackName });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

app.post("/send/settings", async (req, reply) => {
  const b = (req.body ?? {}) as { stackName?: string; maxAttachmentBytes?: number };
  if (typeof b.maxAttachmentBytes !== "number") {
    return reply.code(400).send({ ok: false, error: "maxAttachmentBytes is required" });
  }
  try {
    return await prov.setSendSettings(ctx(), { stackName: b.stackName, maxAttachmentBytes: b.maxAttachmentBytes });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// ---- Teardown: remove everything Mailpoppy deployed for a domain ----

// Read-only: every domain this backend was provisioned for (so the teardown
// confirmation can list them all — DNS/SES is removed for each).
app.get("/teardown/domains/:stackName", async (req, reply) => {
  const stackName = (req.params as { stackName: string }).stackName;
  try {
    const domains = await prov.discoverProvisionedDomains(ctx(), stackName);
    return { ok: true, domains };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Mutating + DESTRUCTIVE: deletes the stack, its RETAINed data (mail bucket,
// DynamoDB tables, Cognito pool), the deploy bucket, the SES identity and the
// DNS records. `domain` is OPTIONAL: when removing leftover infrastructure after
// every domain has already been deleted there's no domain to name — teardownAll
// still discovers + cleans any stragglers (Cognito users / active rule set /
// ledger) and tears down the stack. The UI confirms before calling this. This is
// a long-running request (it waits for CloudFormation DeleteStack to finish).
app.post("/teardown", async (req, reply) => {
  const b = (req.body ?? {}) as { domain?: string; stackName?: string; deleteDeployBucket?: boolean };
  try {
    return await prov.teardownAll(ctx(), {
      domain: b.domain ?? "",
      stackName: b.stackName,
      deleteDeployBucket: b.deleteDeployBucket,
    });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Mutating + DESTRUCTIVE, but scoped to ONE domain: deletes the domain's
// mailboxes (+ their stored mail), its per-domain mail-rules/retention, its SES
// identity and its DNS records — leaving the shared backend stack and every other
// domain intact. The UI requires the user to type the domain to confirm.
app.post("/domain/remove", async (req, reply) => {
  const b = (req.body ?? {}) as { domain?: string; stackName?: string };
  if (!b.domain) return reply.code(400).send({ ok: false, error: "domain is required" });
  try {
    return await prov.removeDomain(ctx(), { domain: b.domain, stackName: b.stackName });
  } catch (err) {
    return reply.code(502).send({ ok: false, error: (err as Error).message });
  }
});

// Container mode: the host assigns the loopback port and injects it (no fixed-port
// discovery). Standalone: PORT env, else the historical 8787.
const port = brokerPort() ?? Number(process.env.PORT ?? 8787);
app
  .listen({ port, host: "127.0.0.1" })
  .then(() => app.log.info(`mailpoppy provisioning sidecar on http://127.0.0.1:${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
