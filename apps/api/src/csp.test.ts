import { describe, expect, it } from "vitest";
import { cspDirectives } from "./csp.js";

describe("cspDirectives", () => {
  it("lets the desktop frame loopback app pages only", () => {
    const desktop = cspDirectives(true);
    expect(desktop.frameSrc).toEqual(["'self'", "http://127.0.0.1:*"]);
    expect(desktop.frameAncestors).toEqual(["'none'"]);
  });

  it("frames nothing extra on a server", () => {
    const server = cspDirectives(false);
    expect(server.frameSrc).toBeUndefined();
    expect(server.frameAncestors).toEqual(["'none'"]);
    // Everything but frame-src is the same in both modes.
    const { frameSrc: _frameSrc, ...desktopRest } = cspDirectives(true);
    expect(server).toEqual(desktopRest);
  });
});
