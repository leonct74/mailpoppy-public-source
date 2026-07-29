# MailPoppy

Host email for your own domains **inside your own AWS account** — set up in minutes, with
desktop, web, and mobile mail clients. One subscription per domain, unlimited mailboxes, no
per-seat fees, no lock-in: your mail lives in your cloud, and you can walk away (or tear it
all down in one click) at any time.

## Runs on AgentsPoppy

MailPoppy is a **poppy** — an app whose backend lives in **your own AWS account**, installed and
supervised by [AgentsPoppy](https://agentspoppy-web--agentspoppy.europe-west4.hosted.app), the
local-first permission broker. The desktop app ships through AgentsPoppy's curated directory:
one click installs it, and every update arrives explained, diffable, and verifiable before you
choose to apply it. This repository exists so anyone (or anyone's AI agent) can read exactly
what MailPoppy does — every AWS call, every permission, every byte that touches your mail —
before installing it.

## What's in this repository

```
packages/core         shared types/models/validation/MIME + mailbox logic
packages/api-client   Cognito-JWT calls to the access API (shared by all clients)
apps/desktop          Tauri + React frontend (the setup wizard + admin + mailbox)
apps/desktop/node-sidecar   Node provisioning engine (AWS SDK v3) — desktop-admin-only
infra                 AWS CDK (TS) → CloudFormation template for the deployable backend
lambdas               TS Lambdas: inbound processor, access API, janitor, suppression
```

This is everything that runs **in your AWS account or on your machine** — the parts you should
be able to audit. The vendor-side services (website, billing) and the mobile app-store clients
are developed separately and are not part of this repository.

## What works today

The full product is live: one-click backend deploy into your AWS account (SES + S3 + Lambda +
DynamoDB + Cognito, no terminal needed), DNS/DKIM/DMARC provisioning, mailboxes with quotas,
inbox/send with attachments, spam & allow/block policies, IMAP migration from your old
provider, optional malware scanning, retention controls, full resource transparency ("what
MailPoppy did to your account"), and one-click teardown. Mobile apps are in the App Store and
Google Play.

## Quickstart (developers)

```bash
npm install                                   # wire workspaces
npm run dev -w @mailpoppy/desktop-sidecar     # start the provisioning sidecar (:8787)
npm run dev -w @mailpoppy/desktop             # start the React frontend (:1420)
npm run typecheck && npm run test             # verify
```

To wrap the desktop frontend as a native **Tauri v2** app, see `apps/desktop/README.md`.

## License

MailPoppy is **source-available** under the
[PolyForm Shield License 1.0.0](./LICENSE): read it, audit it, build it, and use it freely —
but providing a product that competes with MailPoppy is not licensed. The MailPoppy name and
brand are not licensed with the code.
