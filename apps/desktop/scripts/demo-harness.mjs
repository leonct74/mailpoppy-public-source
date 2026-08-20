#!/usr/bin/env node
// Local stand-in for agentspoppy.com's demo embedding. Serves the BUILT frontend
// (dist/ — run `npx vite build` first) exactly the way the site will:
//
//   - iframe sandboxed to allow-scripts ONLY → opaque origin: no cookies, no
//     storage (the sandboxStorage shim must catch it), no same-origin anything
//   - Access-Control-Allow-Origin: * on the assets (ES modules can't load into
//     an opaque origin without it)
//   - ?demo=1 → the WebDemoShell demo inbox
//
//   node scripts/demo-harness.mjs     → open http://127.0.0.1:4173/harness
//
// What to check: the demo inbox renders (folders, three demo messages, the
// "Demo data" banner, the DEMO pill), clicking a message opens it, compose
// opens, and the console shows no [frame] errors. There is nothing real behind
// any of it — no backend, no AWS, no login.
//
// NB for automated testing: synthetic CDP clicks (browser automation) do NOT
// route into the sandboxed frame — that's an automation limitation, not an app
// one. Human clicks work. The postMessage test hook below lets automation
// dispatch a REAL bubbling click from inside the frame instead.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error(`no built frontend at ${dist} — run \`npx vite build\` first`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const HARNESS = `<!doctype html><title>MailPoppy demo harness</title>
<body style="margin:0;background:#333;font-family:sans-serif">
<p style="color:#fff;padding:8px 12px;margin:0">Harness — sandboxed iframe (allow-scripts only), ?demo=1 — what agentspoppy.com will embed</p>
<iframe id="demo" src="/demo/index.html?demo=1" sandbox="allow-scripts"
        style="width:100%;height:calc(100vh - 40px);border:0;background:#fff"></iframe>
<script>
  window.addEventListener("message", (e) => console.log("[frame]", JSON.stringify(e.data)));
</script>
</body>`;

// Injected into the frame's HTML for diagnostics only (the real site injects
// nothing): forwards errors out of the opaque origin, and offers automation a
// way to fire a REAL click inside the frame.
const FORWARDER = `<script>
  window.addEventListener("error", (e) => parent.postMessage({ err: String(e.message), src: String(e.filename) }, "*"));
  window.addEventListener("unhandledrejection", (e) => parent.postMessage({ rej: String(e.reason) }, "*"));
  window.addEventListener("DOMContentLoaded", () =>
    setTimeout(() => parent.postMessage({ rootChildren: document.getElementById("root")?.childElementCount ?? -1 }, "*"), 800));
  window.addEventListener("message", (e) => {
    if (!e.data || !e.data.clickText) return;
    const leaf = [...document.querySelectorAll("div,span,p,button,a")]
      .filter((n) => n.children.length === 0 && (n.textContent || "").includes(e.data.clickText))
      .pop();
    if (leaf) leaf.click();
    parent.postMessage({ clicked: leaf ? leaf.tagName + " " + leaf.textContent.slice(0, 30) : null }, "*");
  });
</script>`;

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/harness") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(HARNESS);
  }
  if (url.pathname.startsWith("/demo/")) {
    const rel = normalize(url.pathname.slice("/demo/".length)).replace(/^(\.\.[/\\])+/, "");
    const file = join(dist, rel || "index.html");
    if (!file.startsWith(dist) || !existsSync(file)) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "access-control-allow-origin": "*",
    });
    if (extname(file) === ".html") {
      return res.end(readFileSync(file, "utf8").replace("<head>", "<head>" + FORWARDER));
    }
    return res.end(readFileSync(file));
  }
  res.writeHead(404);
  res.end("not found");
}).listen(4173, "127.0.0.1", () => console.log("demo harness on http://127.0.0.1:4173/harness"));
