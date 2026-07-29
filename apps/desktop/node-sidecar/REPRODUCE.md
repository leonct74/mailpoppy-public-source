# Reproducing the MailPoppy backend — verify an update before you apply it

MailPoppy runs its email engine as a few AWS Lambda functions **in your own AWS account**.
When the app offers a *backend update*, it is proposing to change code in *your* cloud. You
shouldn't have to take our word for what that code is. This document lets you — or your AI
agent — **rebuild the exact backend bundle from the open source and confirm, hash-for-hash,
that it matches what the app will deploy.** A match is a cryptographic proof that the
deployed backend code is that open source, with no trust in our build machine.

This is Layer 2 of the [Verifiable Updates](https://github.com/leonct74/agentspoppy/blob/main/docs/VERIFIABLE_UPDATES.md)
design *(the AgentsPoppy repo opens in stages — if that link 404s today, it hasn't gone public yet)*. Layer 1 (already shipped) lets you *read the diff* of what changed; Layer 2 (this
doc) lets you *prove the bytes*.

## What is — and isn't — reproducible

| Component | Runs where | Reproducible today? |
| --- | --- | --- |
| **Backend Lambda code** (the update) | Your AWS account | ✅ **Yes** — this doc proves it. |
| **The local app package** (`frontend/` + `backend/index.cjs`) | Your own computer | ✅ **Yes, since 0.1.11** — the package is pure JavaScript, packed STORE/uncompressed, so its sha256 is re-derivable from this open repo. (Before 0.1.11 it was a Node-SEA binary embedding a stock Node runtime + an ad-hoc signature — neither deterministic.) |
| **The AgentsPoppy host** (incl. the Node that runs the backend) | Your own computer | ⚠️ Not byte-for-byte. It's a signed, notarized desktop app; the runtime it provides is pinned by hash inside it. |

Retiring the embedded runtime (agentspoppy `docs/RUNTIMES.md` R1: *declare a runtime, don't ship
one*) is what moved the app package into the reproducible column — there are no opaque binary bytes
left in a MailPoppy release to take on trust. The remaining trust root is the **host** that reports
these hashes, so a maximally-paranoid verifier should still rebuild from source rather than trust a
self-report. We do **not** claim the whole system is "cryptographically verifiable" — we claim the
**backend code you deploy** and the **package you install** are both reproducible.

## What makes the backend build reproducible

- **Pinned toolchain.** `esbuild` is an exact-pinned dependency (no `^`), and every other
  dependency is locked in the repo's `package-lock.json`. `npm ci` installs precisely that
  closure — the same bundler and the same libraries we built with.
- **Deterministic archive.** The Lambda zip is written by our own tiny ZIP writer
  ([`scripts/build-backend-bundle.mjs`](scripts/build-backend-bundle.mjs)): entries sorted,
  fixed `0644` permissions, a fixed UTC mtime (`SOURCE_DATE_EPOCH`, defaulting to the commit
  time), and **no compression** — so there is no `zip`-binary or zlib-version variance. The
  archive hash is a pure function of your code plus that fixed date.
- **No install-layout leak, no timestamps in the code.** The handlers are **minified**, which
  strips esbuild's module-boundary comments (`// ../../node_modules/…`) whose `../` depth would
  otherwise track *where* each dependency resolved in your install tree — a real difference
  between two valid `npm ci` layouts. Minified, the hashed bytes depend on the source, not the
  layout. The one wall-clock field in the manifest (`builtAt`) is informational and feeds no
  verified hash.

> **Verifiers with `SOURCE_DATE_EPOCH` exported:** the `verify:backend` flow handles this for
> you — it strips any ambient `SOURCE_DATE_EPOCH` and pins the rebuild to the epoch recorded in
> the manifest, so a reproducible-build shell setting can't cause a spurious archive mismatch.

## Reproduce it (about 2 minutes)

You need **git** and **Node.js** installed. From a clean directory:

```bash
# 1. Get the exact source the update came from.
git clone https://github.com/leonct74/mailpoppy
cd mailpoppy
git checkout <commit>          # the "to" commit shown in the app / manifest

# 2. Install the PINNED toolchain (not "npm install" — ci respects the lockfile exactly).
npm ci

# 3. Rebuild the backend bundle and compare it to the app's manifest.
#    Save the manifest the app gave you (the "Copy manifest" button, or the block at the
#    bottom of the agent-audit prompt) to manifest.json, then:
npm run verify:backend -w @mailpoppy/desktop-sidecar -- --expected manifest.json
```

- `✅ REPRODUCED` — every proof hash (the content-addressed `artifact` key, the
  `archiveSha256`, and each per-handler `sha256`) matches. The code the app wants to deploy
  **is** this open source. Safe to apply, as far as provenance goes.
- `❌ MISMATCH` — the source does **not** reproduce the claimed artifact. **Do not apply**
  until it's explained. Usual causes: you checked out the wrong commit, you ran `npm install`
  instead of `npm ci`, or the manifest genuinely doesn't match the source.

Run it with no `--expected` to just print this build's hashes for a manual eyeball compare.

## What the hashes mean

The manifest the app deploys carries:

- `artifact` — `lambda-code-<sha>.zip`, content-addressed on the bundled handler code. This
  is the S3 key the update points your Lambdas at; it changes only when the code changes.
- `archiveSha256` — sha256 of the exact zip bytes uploaded to S3 (reproducible on any runtime).
- `handlers[].sha256` — sha256 of each bundled handler `.js` (the per-file proof).
- `build` — `{ node, esbuild, target, sourceDateEpoch, command }`: exactly how it was built,
  so you can reproduce it.

The verifier checks `artifact`, `archiveSha256`, and every `handlers[].sha256`. `builtAt` and
`build.node` are context only (esbuild's output is Node-independent, so a different Node still
reproduces the same hashes as long as `npm ci` installed the pinned esbuild).

## Applying is always your call

Reproducing a build tells you the code is genuine; it does not tell you the code is *good*.
Pair this with the Layer-1 audit ("read the diff, flag anything security-relevant") — the
**"Verify with your AI agent"** button copies a prompt that does both. The app never
auto-applies an update; a human always clicks **Update backend**.
