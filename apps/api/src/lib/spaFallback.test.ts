import { describe, expect, it } from "vitest";
import { servesWebApp } from "./spaFallback.js";

describe("servesWebApp", () => {
  it("answers app routes with the web app", () => {
    for (const url of ["/", "/gallery", "/species/abc?tab=photos", "/settings/general"]) expect(servesWebApp(url)).toBe(true);
  });

  it("leaves missing API and offline map files as 404s", () => {
    for (const url of ["/api", "/api/nope", "/maps", "/maps/world-z8.pmtiles", "/maps/world-z8.pmtiles?v=2"]) {
      expect(servesWebApp(url)).toBe(false);
    }
  });

  it("doesn't mistake a route that merely starts with the same letters", () => {
    expect(servesWebApp("/mapsearch")).toBe(true);
    expect(servesWebApp("/apiary")).toBe(true);
  });
});
