import { describe, expect, it } from "vitest";
import { IUCN_CODES } from "@lifer/shared";
import { iucnBadge, iucnStatValue, iucnTone } from "./iucnDisplay";

describe("iucnBadge", () => {
  it("names an assessed status and tones it by threat", () => {
    expect(iucnBadge("CR")).toMatchObject({ code: "CR", label: "IUCN: Critically Endangered", tone: "threatened" });
    expect(iucnBadge("VU")).toMatchObject({ label: "IUCN: Vulnerable", tone: "threatened" });
    expect(iucnBadge("NT")).toMatchObject({ label: "IUCN: Near Threatened", tone: "near" });
    expect(iucnBadge("LR/cd")).toMatchObject({ label: "IUCN: Lower Risk/conservation dependent", tone: "near" });
    expect(iucnBadge("LC")).toMatchObject({ label: "IUCN: Least Concern", tone: "neutral" });
    expect(iucnBadge("DD")).toMatchObject({ label: "IUCN: Data Deficient", tone: "neutral" });
  });

  it("says Not evaluated by IUCN for NE, subtly, and explains it", () => {
    const badge = iucnBadge("NE")!;
    expect(badge.label).toBe("Not evaluated by IUCN");
    expect(badge.tone).toBe("unassessed");
    expect(badge.title).toMatch(/hasn't assessed/);
  });

  it("adds the stored note to the hover text", () => {
    const note = "Not assessed on its own: IUCN includes it in Madoqua kirkii, rated Least Concern.";
    expect(iucnBadge("NE", note)!.title).toContain(note);
    expect(iucnBadge("LC")!.title).not.toContain("\n");
  });

  it("shows nothing without a usable status", () => {
    expect(iucnBadge(null)).toBeNull();
    expect(iucnBadge(undefined)).toBeNull();
    expect(iucnBadge("Regionally Extinct")).toBeNull();
  });

  it("still reads a legacy spelling an old API might send", () => {
    expect(iucnBadge("least concern")!.label).toBe("IUCN: Least Concern");
    expect(iucnBadge("Critically Endangered")!.tone).toBe("threatened");
  });

  it("covers every stored code", () => {
    for (const code of IUCN_CODES) expect(iucnBadge(code)?.code).toBe(code);
    expect(IUCN_CODES.filter((c) => iucnTone(c) === "threatened")).toEqual(["EX", "EW", "CR", "EN", "VU"]);
  });
});

describe("iucnStatValue", () => {
  it("is the category name, Not evaluated for NE, null for nothing", () => {
    expect(iucnStatValue("EN")).toBe("Endangered");
    expect(iucnStatValue("NE")).toBe("Not evaluated");
    expect(iucnStatValue(null)).toBeNull();
  });
});
