import { describe, it, expect, vi } from "vitest";

/**
 * The web-demo storage shim. The real trigger is agentspoppy.com's sandboxed
 * demo iframe (opaque origin ⇒ every storage access throws SecurityError); here
 * that's simulated by redefining window.localStorage as a throwing getter.
 */
describe("sandboxStorage", () => {
  it("leaves working storage untouched (Tauri / dev / tests)", async () => {
    vi.resetModules();
    localStorage.setItem("keep", "1");
    await import("./sandboxStorage");
    expect(localStorage.getItem("keep")).toBe("1");
    localStorage.removeItem("keep");
  });

  it("installs an in-memory shim when storage access throws (opaque origin)", async () => {
    vi.resetModules();
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      await import("./sandboxStorage");
      // Every Storage operation now works, in memory, for the page's lifetime.
      expect(() => window.localStorage.setItem("a", "b")).not.toThrow();
      expect(window.localStorage.getItem("a")).toBe("b");
      expect(window.localStorage.length).toBe(1);
      expect(window.localStorage.key(0)).toBe("a");
      window.localStorage.removeItem("a");
      expect(window.localStorage.getItem("a")).toBeNull();
      window.localStorage.setItem("c", "d");
      window.localStorage.clear();
      expect(window.localStorage.length).toBe(0);
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
