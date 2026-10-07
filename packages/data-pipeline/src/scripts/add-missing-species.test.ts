import { describe, expect, it } from "vitest";
import { ebirdFormsByBinomial, type EbirdRow } from "./add-missing-species.js";

const row = (sci: string, code: string, category: string, reportAs = ""): EbirdRow => ({
  sci,
  common: "",
  code,
  category,
  family: "Parulidae",
  order: "Passeriformes",
  extinct: false,
  reportAs,
});

describe("ebirdFormsByBinomial", () => {
  const ebird = [
    row("Setophaga coronata", "yerwar", "species"),
    row("Setophaga coronata auduboni", "audwar", "issf", "yerwar"),
    row("Catharus guttatus [auduboni Group]", "herthr2", "issf", "herthr"),
    row("Catharus guttatus", "herthr", "species"),
    row("Fulmarus glacialis glacialis/auduboni", "norful4", "issf", "norful"),
    row("Fulmarus glacialis", "norful", "species"),
  ];
  const forms = ebirdFormsByBinomial(ebird);

  it("names a subspecies group the way other lists give it as a species", () => {
    expect(forms.get("Setophaga auduboni")).toBe("yerwar");
  });

  it("skips groups spanning several subspecies", () => {
    expect(forms.size).toBe(1);
  });
});
