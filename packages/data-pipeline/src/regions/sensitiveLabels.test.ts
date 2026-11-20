import { describe, expect, it } from "vitest";
import type { SensitiveScope } from "@lifer/core/species/sensitiveSpecies.js";
import { unmatchedSensitiveLabels } from "./sensitiveLabels.js";

const list = new Map<string, SensitiveScope>([
  ["A a", { global: true }],
  [
    "B b",
    {
      global: false,
      regions: [
        { region: "Ontario-CA", season: null },
        { region: "Ontairo-CA", season: null },
        { region: "England-GB", season: null },
        { region: "Mexico", season: null },
      ],
    },
  ],
  ["C c", { global: false, regions: [{ region: "Ontairo-CA", season: null }] }],
]);

describe("unmatchedSensitiveLabels", () => {
  it("lists this country's labels no province matches, once each", () => {
    expect(unmatchedSensitiveLabels([{ name: "Ontario" }, { name: "Quebec" }], "Canada", "CA", list)).toEqual([
      "Ontairo-CA",
    ]);
  });

  it("ignores other countries' labels and plain country names", () => {
    expect(unmatchedSensitiveLabels([{ name: "Jalisco" }], "Mexico", "MX", list)).toEqual([]);
  });

  it("matches province names case-insensitively", () => {
    expect(
      unmatchedSensitiveLabels([{ name: "Kent", groupName: "England - South East" }], "United Kingdom", "GB", list),
    ).toEqual([]);
  });
});
