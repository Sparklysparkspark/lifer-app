import { describe, expect, it } from "vitest";
import { parseIucnArchive, parseScientificName, type IucnRedList } from "./iucnRedList.js";
import {
  buildIucnIndex,
  classCompatible,
  decideIucn,
  matchIucn,
  spellingKey,
  type IucnCatalogSpecies,
} from "./iucnMatch.js";
import { parseGbifIucnLink } from "./iucnBackfill.js";

// Rows shaped like the GBIF-hosted Red List archive's taxon.txt and distribution.txt.
const taxonRow = (
  id: string,
  sci: string,
  cls: string,
  genus: string,
  epithet: string,
  status = "accepted",
  accepted = id,
  kingdom = "ANIMALIA",
) =>
  [
    id,
    sci,
    kingdom,
    "CHORDATA",
    cls,
    "",
    "",
    genus,
    epithet,
    "",
    status === "accepted" ? "species" : "",
    "",
    status,
    accepted,
    "",
    "",
  ].join("\t");
const distRow = (id: string, threat: string) => [id, "", "Global", "", "", threat, "Present"].join("\t");

describe("parseScientificName", () => {
  it("strips authorship and subgenera, and keeps a trinomial's third epithet", () => {
    expect(parseScientificName("Passer domesticus (Linnaeus, 1758)")).toEqual({
      binomial: "Passer domesticus",
      infraEpithet: null,
    });
    expect(parseScientificName("Conus (Leptoconus) ammiralis Linnaeus, 1758")).toEqual({
      binomial: "Conus ammiralis",
      infraEpithet: null,
    });
    expect(parseScientificName("Potamon gedrosianum Pretzmann, 1965 ssp. waziristanis")).toEqual({
      binomial: "Potamon gedrosianum",
      infraEpithet: "waziristanis",
    });
    expect(parseScientificName("Potamon gedrosianum ssp. waziristanis Pretzmann")).toEqual({
      binomial: "Potamon gedrosianum",
      infraEpithet: "waziristanis",
    });
    expect(parseScientificName("Gloydius halys caucasicus (Nikolsky, 1916)")).toEqual({
      binomial: "Gloydius halys",
      infraEpithet: "caucasicus",
    });
  });

  it("doesn't mistake an author particle for an epithet, and refuses non-names", () => {
    expect(parseScientificName("Felis concolor de Blainville")).toEqual({
      binomial: "Felis concolor",
      infraEpithet: null,
    });
    expect(parseScientificName("lowercase thing")).toBeNull();
    expect(parseScientificName("Genus")).toBeNull();
    expect(parseScientificName("Albigarrdia boeckleriana (Schweinf.) K.Lye ssp. (K.Schum.)")).toBeNull();
  });
});

describe("parseIucnArchive", () => {
  it("keeps assessed animal species with a global category, and synonyms that point at one", () => {
    const taxa = [
      taxonRow("1", "Passer domesticus (Linnaeus, 1758)", "AVES", "Passer", "domesticus"),
      taxonRow("2", "Calocedrus rupestris Aver.", "PINOPSIDA", "Calocedrus", "rupestris", "accepted", "2", "PLANTAE"),
      taxonRow("3", "Hydrobates furcatus (Gmelin, 1789)", "AVES", "Hydrobates", "furcatus"),
      taxonRow("3_1", "Oceanodroma furcata (Gmelin, 1789)", "", "", "", "synonym", "3"),
      taxonRow("9_1", "Orphanus synonymus Smith", "", "", "", "synonym", "9"),
      taxonRow("4", "Bird withoutstatus", "AVES", "Bird", "withoutstatus"),
    ].join("\n");
    const dist = [
      distRow("1", "Least Concern"),
      distRow("2", "Endangered"),
      distRow("3", "near threatened"),
      distRow("4", "Regionally Extinct"),
    ].join("\n");
    const list = parseIucnArchive(taxa, dist, "IUCN (2026)");
    expect(list.accepted).toEqual([
      { taxonId: 1, name: "Passer domesticus", className: "AVES", code: "LC" },
      // The lower-case label is the 1994 Lower Risk/near threatened, equated with NT.
      { taxonId: 3, name: "Hydrobates furcatus", className: "AVES", code: "NT" },
    ]);
    expect(list.synonyms).toEqual([{ name: "Oceanodroma furcata", acceptedTaxonId: 3, infraEpithet: null }]);
    expect(list.citation).toBe("IUCN (2026)");
  });
});

describe("spellingKey", () => {
  it("collapses Latin endings that change with a genus move", () => {
    expect(spellingKey("Pethia ornatus")).toBe(spellingKey("Pethia ornata"));
    expect(spellingKey("Lycalopex grisea")).toBe(spellingKey("Lycalopex griseus"));
    expect(spellingKey("Psammophis phillipsii")).toBe(spellingKey("Psammophis phillipsi"));
    expect(spellingKey("Trichomycterus guianense")).toBe(spellingKey("Trichomycterus guianensis"));
    expect(spellingKey("Xus niger")).toBe(spellingKey("Xus nigra"));
    expect(spellingKey("Xus albus")).not.toBe(spellingKey("Xus alienus"));
    expect(spellingKey("Xus a")).toBeNull();
  });
});

describe("classCompatible", () => {
  it("keeps a catalog group to its IUCN classes, and lets an unknown group through", () => {
    expect(classCompatible("aves", "AVES")).toBe(true);
    expect(classCompatible("aves", "GASTROPODA")).toBe(false);
    expect(classCompatible("squamata", "REPTILIA")).toBe(true);
    expect(classCompatible("insecta", "INSECTA")).toBe(true);
  });
});

function redList(): IucnRedList {
  return {
    citation: null,
    accepted: [
      { taxonId: 10, name: "Passer domesticus", className: "AVES", code: "LC" },
      { taxonId: 11, name: "Hydrobates furcatus", className: "AVES", code: "NT" },
      { taxonId: 12, name: "Madoqua kirkii", className: "MAMMALIA", code: "LC" },
      { taxonId: 13, name: "Curruca curruca", className: "AVES", code: "LC" },
      { taxonId: 14, name: "Lycalopex griseus", className: "MAMMALIA", code: "LC" },
      { taxonId: 15, name: "Sittiparus varius", className: "AVES", code: "LC" },
      { taxonId: 16, name: "Sittiparus owstoni", className: "AVES", code: "VU" },
      { taxonId: 17, name: "Gloydius halys", className: "REPTILIA", code: "LC" },
      { taxonId: 18, name: "Conus solidus", className: "GASTROPODA", code: "DD" },
      { taxonId: 19, name: "Petauroides volans", className: "MAMMALIA", code: "EN" },
      { taxonId: 20, name: "Leucogeranus leucogeranus", className: "AVES", code: "CR" },
    ],
    synonyms: [
      { name: "Oceanodroma furcata", acceptedTaxonId: 11, infraEpithet: null },
      { name: "Madoqua damarensis", acceptedTaxonId: 12, infraEpithet: null },
      { name: "Sylvia curruca", acceptedTaxonId: 13, infraEpithet: null },
      { name: "Poecile varius", acceptedTaxonId: 15, infraEpithet: null },
      { name: "Poecile varius", acceptedTaxonId: 16, infraEpithet: null },
      { name: "Gloydius halys", acceptedTaxonId: 17, infraEpithet: "caucasicus" },
      { name: "Petauroides armillatus", acceptedTaxonId: 19, infraEpithet: null },
      { name: "Petauroides minor", acceptedTaxonId: 19, infraEpithet: null },
    ],
  };
}

const sp = (
  id: string,
  scientificName: string,
  taxonClass: string,
  extra: Partial<IucnCatalogSpecies> = {},
): IucnCatalogSpecies => ({
  id,
  scientificName,
  taxonClass,
  ...extra,
});

describe("matchIucn", () => {
  const index = buildIucnIndex(redList());

  it("matches an exact name, case and spacing aside", () => {
    const m = matchIucn([sp("a", "passer  Domesticus", "aves")], index);
    expect(m.get("a")).toMatchObject({ kind: "assessed", method: "name", taxonId: 10, code: "LC" });
  });

  it("follows IUCN's own synonyms (a genus move)", () => {
    const m = matchIucn([sp("a", "Oceanodroma furcata", "aves")], index);
    expect(m.get("a")).toMatchObject({
      kind: "assessed",
      method: "synonym",
      code: "NT",
      iucnName: "Hydrobates furcatus",
    });
  });

  it("follows the catalog's own synonyms", () => {
    const m = matchIucn([sp("a", "Grus leucogeranus", "aves", { synonyms: ["Leucogeranus leucogeranus"] })], index);
    expect(m.get("a")).toMatchObject({ kind: "assessed", method: "catalog_synonym", code: "CR" });
  });

  it("uses GBIF's key link when the names fail, and a spelling variant last", () => {
    const m = matchIucn(
      [sp("a", "Zzunknown name", "aves", { gbifIucnTaxonId: 11 }), sp("b", "Lycalopex grisea", "mammalia")],
      index,
    );
    expect(m.get("a")).toMatchObject({ kind: "assessed", method: "gbif_key", taxonId: 11 });
    expect(m.get("b")).toMatchObject({ kind: "assessed", method: "spelling", taxonId: 14 });
  });

  it("never takes a status across classes (a homonym in another group)", () => {
    const m = matchIucn([sp("a", "Conus solidus", "aves")], index);
    expect(m.get("a")).toEqual({ kind: "none", ambiguous: false });
  });

  it("doesn't let a split inherit its parent's status", () => {
    // The catalog has both Madoqua kirkii and the split Madoqua damarensis; IUCN still lumps them.
    const m = matchIucn(
      [sp("parent", "Madoqua kirkii", "mammalia"), sp("split", "Madoqua damarensis", "mammalia")],
      index,
    );
    expect(m.get("parent")).toMatchObject({ kind: "assessed", method: "name" });
    expect(m.get("split")).toMatchObject({
      kind: "part_of",
      via: "lumped",
      parentName: "Madoqua kirkii",
      parentCode: "LC",
    });
  });

  it("treats two catalog species reaching one assessment indirectly as a split, not a match", () => {
    const m = matchIucn(
      [sp("a", "Petauroides armillatus", "mammalia"), sp("b", "Petauroides minor", "mammalia")],
      index,
    );
    expect(m.get("a")).toMatchObject({ kind: "part_of", via: "lumped", parentCode: "EN" });
    expect(m.get("b")).toMatchObject({ kind: "part_of", via: "lumped" });
  });

  it("gives a same-epithet duplicate (an old genus) the status, flagged as a likely duplicate", () => {
    const m = matchIucn([sp("new", "Curruca curruca", "aves"), sp("old", "Sylvia curruca", "aves")], index);
    expect(m.get("old")).toMatchObject({ kind: "assessed", method: "synonym", code: "LC", duplicateOf: "new" });
  });

  it("calls a name IUCN splits several ways ambiguous", () => {
    const m = matchIucn([sp("a", "Poecile varius", "aves")], index);
    expect(m.get("a")).toEqual({ kind: "none", ambiguous: true });
  });

  it("recognizes a species IUCN keeps as a subspecies, and a recorded split", () => {
    const m = matchIucn(
      [
        sp("a", "Gloydius caucasicus", "squamata"),
        sp("b", "Passer italiae", "aves", { splitFromName: "Passer domesticus" }),
      ],
      index,
    );
    expect(m.get("a")).toMatchObject({ kind: "part_of", via: "subspecies", parentName: "Gloydius halys" });
    expect(m.get("b")).toMatchObject({ kind: "part_of", via: "split", parentName: "Passer domesticus" });
  });
});

describe("decideIucn", () => {
  const none = { status: null, source: null } as const;

  it("stores an assessment as the Red List's code", () => {
    expect(
      decideIucn(
        { kind: "assessed", method: "synonym", taxonId: 11, code: "NT", iucnName: "Hydrobates furcatus" },
        "aves",
        none,
      ),
    ).toEqual({
      status: "NT",
      source: "iucn_red_list",
      note: null,
      taxonId: 11,
    });
  });

  it("stores a split as Not Evaluated with a note naming the parent", () => {
    const d = decideIucn(
      { kind: "part_of", via: "lumped", taxonId: 12, parentName: "Madoqua kirkii", parentCode: "LC" },
      "mammalia",
      {
        status: "LC",
        source: "wikidata",
      },
    );
    expect(d.status).toBe("NE");
    expect(d.note).toBe("Not assessed on its own: IUCN includes it in Madoqua kirkii, rated Least Concern.");
  });

  it("records Not Evaluated for a miss in a group IUCN doesn't cover comprehensively", () => {
    expect(decideIucn({ kind: "none", ambiguous: false }, "nudibranchs", none)).toEqual({
      status: "NE",
      source: "iucn_red_list",
      note: null,
      taxonId: null,
    });
  });

  it("leaves a miss in a comprehensively assessed group undecided, unless GBIF's key link agrees", () => {
    const miss = decideIucn({ kind: "none", ambiguous: false }, "aves", none);
    expect(miss.status).toBeNull();
    expect(miss.note).toMatch(/No IUCN assessment found/);
    const confirmed = decideIucn({ kind: "none", ambiguous: false }, "aves", none, true);
    expect(confirmed.status).toBe("NE");
    expect(confirmed.note).toMatch(/recently described/);
  });

  it("keeps another source's real status on a miss, and never assigns an ambiguous name", () => {
    expect(
      decideIucn({ kind: "none", ambiguous: false }, "nudibranchs", { status: "DD", source: "wikidata" }),
    ).toMatchObject({
      status: "DD",
      source: "wikidata",
    });
    expect(decideIucn({ kind: "none", ambiguous: true }, "fish", none)).toMatchObject({ status: null });
  });
});

describe("parseGbifIucnLink", () => {
  it("reads GBIF's iucnRedListCategory answers", () => {
    expect(
      parseGbifIucnLink(
        '{"category":"LEAST_CONCERN","iucnTaxonID":"103818789","taxonomicStatus":"ACCEPTED","code":"LC"}',
      ),
    ).toEqual({
      taxonId: 103818789,
      notEvaluated: false,
    });
    expect(parseGbifIucnLink('{"category":"NOT_EVALUATED","taxonomicStatus":"ACCEPTED","code":"NE"}')).toEqual({
      taxonId: null,
      notEvaluated: true,
    });
    // About a synonym usage, GBIF's NE says nothing about the accepted species.
    expect(parseGbifIucnLink('{"category":"NOT_EVALUATED","taxonomicStatus":"SYNONYM","code":"NE"}')).toEqual({
      taxonId: null,
      notEvaluated: false,
    });
    expect(parseGbifIucnLink("")).toEqual({ taxonId: null, notEvaluated: false });
  });
});
