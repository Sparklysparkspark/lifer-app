import { describe, expect, it } from "vitest";
import { SUGGESTED_APPS } from "./suggestedApps";
import { appNavLabel, appTitle } from "./appName";

describe("appName", () => {
  it("gives any app a sidebar label and its own name, and nothing else", () => {
    const app = { id: "com.example.birds", name: "Example Birds", page: { label: "Birds" } };
    expect(appNavLabel(app)).toBe("Birds");
    expect(appTitle(app)).toBe("Example Birds");
    expect(appNavLabel({ id: "x" })).toBe("x");
  });

  it("uses a suggested app's own label and name whatever its manifest says", () => {
    for (const s of SUGGESTED_APPS) {
      const installed = { id: s.id, name: "Manifest name", page: { label: "Manifest label" } };
      expect(appNavLabel(installed)).toBe(s.label);
      expect(appTitle(installed)).toBe(s.name);
    }
  });
});
