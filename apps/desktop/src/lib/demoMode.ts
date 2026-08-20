/**
 * The in-browser demo flag. agentspoppy.com serves this frontend (extracted from
 * the released package) in a sandboxed iframe with `?demo=1` — no backend, no
 * broker, no AWS, nothing to set up. Under the flag the app boots straight into
 * the demo inbox instead of the admin surface: every admin tab needs the local
 * helper process, which a web page rightly doesn't have.
 */
export function isWebDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("demo") === "1";
  } catch {
    return false;
  }
}
