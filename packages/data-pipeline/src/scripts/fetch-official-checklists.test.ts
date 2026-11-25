import { describe, expect, it } from "vitest";
import {
  buildIndex,
  habitat,
  isUnseenDeepSea,
  levenshtein,
  matchOfficial,
  type OfficialRow,
  rowsToTsv,
  statusGroup,
  tsvToRows,
} from "./fetch-official-checklists.js";

const row = (o: Partial<OfficialRow>): OfficialRow => ({
  name: "Abalistes stellatus",
  specCode: 9,
  fbClass: "Teleostei",
  family: "Balistidae",
  status: "native",
  presence: "present",
  fresh: false,
  brack: false,
  salt: true,
  depthDeep: 350,
  demersPelag: "reef-associated",
  synonyms: [],
  ...o,
});

const idx = buildIndex([
  { id: "a", name: "Abalistes stellatus", fish: true, synonyms: [] },
  { id: "b", name: "Charadrius mongolus", fish: false, synonyms: ["Anarhynchus mongolus"] },
  { id: "c", name: "Tachysurus sinensis", fish: true, synonyms: ["Pelteobagrus sinensis"] },
  { id: "d", name: "Rhinogobius kurodai", fish: true, synonyms: [] },
  { id: "e", name: "Etrumeus teres", fish: true, synonyms: ["Shared name"] },
  { id: "f", name: "Etrumeus micropus", fish: true, synonyms: ["Shared name"] },
]);

describe("statusGroup and habitat", () => {
  it("groups FishBase statuses", () => {
    expect(statusGroup("endemic")).toBe("confirmed");
    expect(statusGroup("introduced")).toBe("confirmed");
    expect(statusGroup("questionable")).toBe("possible");
    expect(statusGroup("misidentification")).toBe("rejected");
    expect(statusGroup("not established")).toBe("rejected");
  });
  it("reads habitat flags", () => {
    expect(habitat(row({}))).toBe("marine");
    expect(habitat(row({ fresh: true, salt: false }))).toBe("freshwater");
    expect(habitat(row({ fresh: true, brack: true, salt: true }))).toBe("both");
    expect(habitat(row({ fresh: false, brack: true, salt: false }))).toBe("marine");
  });
  it("marks only unphotographed deep-water marine fish as the unseen tail", () => {
    expect(isUnseenDeepSea(row({ demersPelag: "bathydemersal" }), 0)).toBe(true);
    expect(isUnseenDeepSea(row({ demersPelag: "bathydemersal" }), 3)).toBe(false);
    expect(isUnseenDeepSea(row({ demersPelag: "reef-associated" }), 0)).toBe(false);
  });
});

describe("matchOfficial", () => {
  const accepted = new Set(["Abalistes stellatus", "Etrumeus micropus", "Rhinogobius fluviatilis"]);
  it("matches the exact name first", () => {
    expect(matchOfficial(row({}), idx, accepted)).toMatchObject({ kind: "exact", speciesId: "a" });
  });
  it("matches a catalog synonym or a FishBase synonym", () => {
    expect(matchOfficial(row({ name: "Pelteobagrus sinensis" }), idx, accepted)).toMatchObject({
      kind: "synonym",
      speciesId: "c",
    });
    expect(
      matchOfficial(row({ name: "Pseudobagrus sinensis", synonyms: ["Tachysurus sinensis"] }), idx, accepted),
    ).toMatchObject({
      kind: "synonym",
      speciesId: "c",
    });
  });
  it("never takes a synonym FishBase accepts as its own species", () => {
    expect(matchOfficial(row({ name: "Etrumeus sadina", synonyms: ["Etrumeus micropus"] }), idx, accepted).kind).toBe(
      "none",
    );
  });
  it("ignores a synonym two catalog species share", () => {
    expect(matchOfficial(row({ name: "Shared name" }), idx, accepted).kind).not.toBe("synonym");
  });
  it("matches a unique near spelling, not one FishBase accepts", () => {
    expect(matchOfficial(row({ name: "Rhinogobius kurodae" }), idx, accepted)).toMatchObject({
      kind: "fuzzy",
      speciesId: "d",
    });
    expect(matchOfficial(row({ name: "Abalistes stellaris" }), idx, accepted).kind).toBe("none");
  });
  it("measures edit distance", () => {
    expect(levenshtein("kurodai", "kurodae")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("checklist TSV", () => {
  it("round-trips", () => {
    const rows = [
      row({ synonyms: ["Balistes stellatus", "Balistes phaleratus"] }),
      row({ name: "X y", depthDeep: null, fresh: true }),
    ];
    expect(tsvToRows(rowsToTsv(rows))).toEqual(rows);
  });
});
