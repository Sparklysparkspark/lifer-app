import { describe, expect, it } from "vitest";
import { inatAncestorNames, readInatResults } from "./reconcile-species-names.js";

// Shapes taken from real iNaturalist responses.
describe("readInatResults", () => {
  it("finds the current species for a renamed one", () => {
    expect(
      readInatResults("Accipiter bicolor", [
        { id: 1579012, name: "Astur bicolor", rank: "species", is_active: true, matched_term: "Accipiter bicolor" },
        { id: 1579013, name: "Astur chilensis", rank: "species", is_active: true, matched_term: "Accipiter bicolor chilensis" },
      ]),
    ).toEqual({ id: 1579012, name: "Astur bicolor" });
  });

  it("gives nothing when two species match the name exactly, or none does", () => {
    expect(
      readInatResults("Aus bus", [
        { id: 1, name: "Aus bus", rank: "species", matched_term: "Aus bus" },
        { id: 2, name: "Cus bus", rank: "species", matched_term: "Aus bus" },
      ]),
    ).toBeNull();
    expect(readInatResults("Aus bus", [{ id: 3, name: "Aus busi", rank: "species", matched_term: "Aus busi" }])).toBeNull();
  });

  it("ignores inactive taxa and higher ranks", () => {
    expect(
      readInatResults("Aus bus", [
        { id: 4, name: "Aus bus", rank: "species", is_active: false, matched_term: "Aus bus" },
        { id: 5, name: "Aus", rank: "genus", matched_term: "Aus bus" },
      ]),
    ).toBeNull();
  });
});

describe("inatAncestorNames", () => {
  // iNaturalist's real history: Accipiter gentilis was split (Accipiter atricapillus out of it),
  // then Accipiter atricapillus was renamed Astur atricapillus.
  const changes: Record<number, any[]> = {
    1579016: [
      {
        type: "TaxonSwap",
        status: "committed",
        input_taxa: [{ id: 1505782, name: "Accipiter atricapillus" }],
        output_taxa: [{ id: 1579016, name: "Astur atricapillus" }],
      },
    ],
    1505782: [
      {
        type: "TaxonSplit",
        status: "committed",
        input_taxa: [{ id: 5106, name: "Accipiter gentilis" }],
        output_taxa: [
          { id: 1505781, name: "Accipiter gentilis" },
          { id: 1505782, name: "Accipiter atricapillus" },
        ],
      },
      // A later change where it was the input, not the output: not part of where it came from.
      {
        type: "TaxonSwap",
        status: "committed",
        input_taxa: [{ id: 1505782, name: "Accipiter atricapillus" }],
        output_taxa: [{ id: 1579016, name: "Astur atricapillus" }],
      },
    ],
  };
  const fetchChanges = async (id: number) => changes[id] ?? [];

  it("walks American Goshawk back to Northern Goshawk", async () => {
    expect(await inatAncestorNames(1579016, fetchChanges)).toEqual([
      { name: "Accipiter atricapillus", depth: 1 },
      { name: "Accipiter gentilis", depth: 2 },
    ]);
  });

  it("stops at the depth limit and skips uncommitted changes", async () => {
    expect(await inatAncestorNames(1579016, fetchChanges, 1)).toEqual([{ name: "Accipiter atricapillus", depth: 1 }]);
    const draft = async () => [{ status: "draft", input_taxa: [{ id: 9, name: "Old name" }], output_taxa: [{ id: 1, name: "New" }] }];
    expect(await inatAncestorNames(1, draft)).toEqual([]);
  });
});
