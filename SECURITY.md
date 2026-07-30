# Security Policy

MailPoppy is built around a single promise: your email and your AWS credentials stay yours.
The code that runs in your AWS account and the code that touches your AWS credentials are
published so that promise can be checked rather than trusted. Security reports are welcome,
and responsible disclosure is appreciated.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Email **support@mailpoppy.com** with `SECURITY` in the subject, and include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected component and version.

You'll get an acknowledgement within **3 business days**, updates as the report is
investigated, and word when a fix ships. Credit for the disclosure is offered unless you'd
rather stay anonymous. Please allow a reasonable window for a fix before disclosing publicly.

## Scope

In scope — everything in this repository, which is everything that runs in your AWS account
or on your machine:

- `lambdas/` — the mail backend deployed into the customer's account (inbound processor,
  access API, janitor, suppression).
- `infra/` — the CDK stack and the least-privilege IAM policies in `infra/policies/`.
- `packages/` — shared mailbox logic, MIME handling and the API client.
- `apps/desktop/` — the desktop admin app, including `node-sidecar/`, the provisioning engine
  that reads AWS credentials.

Out of scope here, but still worth reporting to the same address: the vendor-side website and
billing, the mobile clients, and third-party services (AWS itself, the app stores).

## What deserves the closest look

- **Credential handling in the sidecar.** It resolves AWS credentials from the local profile
  chain and must never transmit or log them. Anything suggesting otherwise is a serious bug.
- **Tenant isolation in the access API.** A signed-in mailbox must never be able to read,
  modify or send as another mailbox — enforced server-side from verified Cognito claims.
- **The IAM policies.** They should permit only MailPoppy's own email stack and nothing else
  in the account.
- **Anything in the mail path that could move data outside the user's own AWS account.**

## A note on this repository

The public repository is a read-only mirror, exported from a private monorepo. Pull requests
against it can't be merged — the next export would overwrite them. Please send security
reports by email, and other issues to **support@mailpoppy.com**.
