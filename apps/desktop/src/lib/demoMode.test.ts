import { describe, it, expect } from "vitest";
import { isWebDemo } from "./demoMode";

describe("isWebDemo", () => {
  it("is true only for ?demo=1", () => {
    window.history.replaceState(null, "", "/?demo=1");
    expect(isWebDemo()).toBe(true);
    window.history.replaceState(null, "", "/?demo=1&x=2");
    expect(isWebDemo()).toBe(true);
    window.history.replaceState(null, "", "/?demo=0");
    expect(isWebDemo()).toBe(false);
    window.history.replaceState(null, "", "/");
    expect(isWebDemo()).toBe(false);
  });
});
