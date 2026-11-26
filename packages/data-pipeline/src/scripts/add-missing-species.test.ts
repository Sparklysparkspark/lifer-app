import { describe, expect, it } from "vitest";
import {
  ebirdFormsByBinomial,
  GROUP_CLADES,
  placeTaxon,
  WIDENED_MARINE_CLADES,
  type EbirdRow,
  type TaxonDetail,
} from "./add-missing-species.js";

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

  it("names a bracketed group after its namesake subspecies", () => {
    expect(forms.get("Catharus auduboni")).toBe("herthr");
  });

  it("skips slash forms spanning several subspecies", () => {
    expect(forms.size).toBe(2);
  });
});

describe("marine clades", () => {
  const clades: Array<[number, string, string]> = GROUP_CLADES.flatMap(([group, names]) =>
    names.map((n): [number, string, string] => [0, group, n]),
  ).map(([, g, n], i): [number, string, string] => [i + 1, g, n]);
  const idOf = (name: string) => clades.find(([, , n]) => n === name)![0];
  const taxon = (name: string, clade: string, over: Partial<TaxonDetail> = {}): TaxonDetail => ({
    rank: "species",
    active: true,
    ancestors: [999_999, idOf(clade)],
    common: "Some Name",
    name,
    extinct: false,
    obs: 50,
    ...over,
  });
  const marine = new Set(["Mytilus edulis", "Cerithium litteratum"]);
  const place = (t: TaxonDetail) => placeTaxon(t, clades, (n) => marine.has(n));

  it("files every widened clade under exactly one group, sea slugs with nudibranchs", () => {
    for (const c of WIDENED_MARINE_CLADES) expect(clades.filter(([, , n]) => n === c)).toHaveLength(1);
    expect(place(taxon("Elysia crispata", "Sacoglossa"))).toEqual({ group: "nudibranchs", clade: "Sacoglossa" });
    expect(place(taxon("Plexaura homomalla", "Octocorallia"))?.group).toBe("corals");
    expect(place(taxon("Holothuria mexicana", "Holothuroidea"))?.group).toBe("echinodermata");
    expect(place(taxon("Odontodactylus scyllarus", "Stomatopoda"))?.group).toBe("crustacea");
  });

  it("leaves isopods out", () => {
    expect(clades.some(([, , n]) => n === "Isopoda")).toBe(false);
  });

  it("takes a bivalve, cerith or nerite only with an OBIS marine record", () => {
    expect(place(taxon("Mytilus edulis", "Bivalvia"))?.group).toBe("marine_mollusks");
    expect(place(taxon("Unio pictorum", "Bivalvia"))).toBeNull();
    expect(place(taxon("Cerithium litteratum", "Cerithioidea"))).not.toBeNull();
    expect(place(taxon("Melanoides tuberculata", "Cerithioidea"))).toBeNull();
    expect(place(taxon("Nerita peloronta", "Cycloneritida"))).toBeNull();
    // Chitons are all marine: no record needed.
    expect(place(taxon("Acanthopleura granulata", "Polyplacophora"))).not.toBeNull();
  });

  it("keeps the visibility floor for the new invertebrates", () => {
    expect(place(taxon("Ophiothrix suensoni", "Ophiuroidea", { common: null, obs: 9 }))).toBeNull();
    expect(place(taxon("Ophiothrix suensoni", "Ophiuroidea", { common: null, obs: 10 }))).not.toBeNull();
  });
});
