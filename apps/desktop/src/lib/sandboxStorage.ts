/**
 * Sandbox-safe storage — MUST be the FIRST import in main.tsx (side-effect module).
 *
 * agentspoppy.com embeds this frontend as an in-browser demo inside an iframe
 * sandboxed WITHOUT allow-same-origin. That gives the document an opaque origin,
 * and on an opaque origin EVERY window.localStorage / sessionStorage access throws
 * a SecurityError — including reads sprinkled through this app (deployment config,
 * region, dismissed banners, Cognito's token store). One unguarded touch blanks
 * the whole demo.
 *
 * Instead of guarding every call site, install an in-memory Storage over the
 * throwing one, once, before anything else loads. Import order matters: ES module
 * imports are hoisted and evaluated depth-first in statement order, so this module
 * only runs before the rest of the app if its import line comes first — a shim
 * written inline in main.tsx would run AFTER every dependency's module-scope code.
 *
 * Outside the sandbox (Tauri webview, AgentsPoppy frame, dev server, tests) the
 * probe succeeds and this module does nothing at all.
 */

function memoryStorage(): Storage {
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    key: (i: number) => [...mem.keys()][i] ?? null,
    removeItem: (k: string) => {
      mem.delete(k);
    },
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  try {
    // Any property access throws on an opaque origin — this probe is the detection.
    window[name].getItem("__mailpoppy_probe__");
  } catch {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
  }
}

export {};
