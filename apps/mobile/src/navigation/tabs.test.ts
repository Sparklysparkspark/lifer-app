import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import { TABS } from "./tabs";

const lookup = (key: string) => key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], en);

describe("tabs", () => {
  it("are the four tabs in order, with the desktop's names", () => {
    expect(TABS.map((t) => t.name)).toEqual(["Collection", "Gallery", "Albums", "Identify"]);
  });
  it("every label exists in en.json", () => {
    for (const t of TABS) expect(typeof lookup(t.label)).toBe("string");
  });
});
