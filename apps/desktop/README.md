# @mailpoppy/desktop

The desktop app = a **React/Vite frontend** + a **Node provisioning backend** (`./node-sidecar`).
It ships as an **AgentsPoppy poppy**: the package is pure JavaScript (`frontend/` + one
`backend/index.cjs`) and the host runs the backend on its **shared node22 runtime** — MailPoppy
bundles no Node of its own (agentspoppy `docs/RUNTIMES.md`, rule R1). AWS credentials never enter
the webview.

A thin **Tauri v2** shell (`./src-tauri`) remains for local development, so you can drive the UI in
a native window. It spawns no subprocess: run the backend from source alongside it (below).

## Run in the browser (fastest dev loop)

```bash
npm run dev -w @mailpoppy/desktop-sidecar   # provisioning API on :8787 (set AWS_PROFILE / AWS_REGION)
npm run dev -w @mailpoppy/desktop           # frontend on :1420
```

## Run as the native app (Tauri dev)

```bash
npm run dev -w @mailpoppy/desktop-sidecar   # the backend, from source via tsx, on :8787
npm run tauri:dev -w @mailpoppy/desktop     # the shell + Vite frontend
```

`beforeDevCommand` runs `npm run dev` (Vite). The shell hosts the webview only — start the backend
yourself in the other terminal.

## Build the shippable package

```bash
# from apps/desktop/
npm run build:bundle   # → backend/index.cjs (+ the embedded CDK bundle + extension.json)
npm run build          # → dist/ (Vite)
```

Then pack + publish per **[RELEASE.md](./RELEASE.md)**. There is no standalone `.app`/`.dmg`
release: users install and update MailPoppy through AgentsPoppy.

## The backend bundle

`npm run build:bundle` (→ `node-sidecar/scripts/build-node-bundle.mjs`):

1. regenerates the embedded one-click-deploy **CDK bundle** (CloudFormation template + Lambda zip)
   that `provisioning.ts` imports;
2. **esbuild** bundles `node-sidecar/src/index.ts` (+ `@mailpoppy/core`, fastify, AWS SDK v3) into
   one CJS file at `backend/index.cjs`;
3. regenerates `extension.json` from `extensionManifest.ts` (the single source of truth).

⚠️ The old **Node SEA** pipeline (`build-sidecar.mjs`, which injected the bundle into a copy of the
Node runtime) was **retired in 0.1.11**. Embedding a runtime is forbidden on the platform and is
rejected at pack time, at review, and by the broker — declare `"runtime": "node22"` instead.

## Layout

| Path | What |
|---|---|
| `src/` | React frontend (views, lib, MailClient) |
| `node-sidecar/` | Node provisioning sidecar (Fastify + AWS SDK v3) |
| `src-tauri/` | Tauri v2 Rust shell (`src/lib.rs` spawns the sidecar), `tauri.conf.json`, icons |
| `src-tauri/binaries/` | generated sidecar executable (git-ignored) |
