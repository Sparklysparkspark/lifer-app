import { describe, expect, it } from "vitest";
import { pickMatches, readTargetNames } from "./targetListCsv.js";

describe("readTargetNames", () => {
  it("prefers the scientific name column, any header spelling", () => {
    const csv = 'common_name,SCIENTIFIC NAME\n"Robin, American",Turdus migratorius\nBlue Jay,Cyanocitta cristata\n';
    expect(readTargetNames(csv)).toEqual(["Turdus migratorius", "Cyanocitta cristata"]);
  });

  it("falls back to the common name column", () => {
    expect(readTargetNames("Common Name,Notes\nBlue Jay,yard\nBlue Jay,again\n")).toEqual(["Blue Jay"]);
  });

  it("reads a one-column file with no header", () => {
    expect(readTargetNames("Blue Jay\r\nTurdus migratorius\r\n\r\n")).toEqual(["Blue Jay", "Turdus migratorius"]);
  });

  it("refuses a file with several columns and no name column", () => {
    expect(() => readTargetNames("a,b\n1,2\n")).toThrow(/Scientific Name/);
    expect(() => readTargetNames("")).toThrow(/empty/);
  });
});

describe("pickMatches", () => {
  it("ranks scientific over synonym over common, and flags ties as ambiguous", () => {
    const result = pickMatches(
      ["Alpha", "Beta", "Gamma", "Nope"],
      [
        { name: "Alpha", speciesId: "s1", kind: "common" },
        { name: "Alpha", speciesId: "s2", kind: "scientific" },
        { name: "Beta", speciesId: "s3", kind: "synonym" },
        { name: "Beta", speciesId: "s4", kind: "alias" },
        { name: "Gamma", speciesId: "s5", kind: "common" },
        { name: "Gamma", speciesId: "s6", kind: "alias" },
        { name: "Gamma", speciesId: "s5", kind: "alias" },
      ],
    );
    expect(result).toEqual([
      { name: "Alpha", status: "matched", speciesIds: ["s2"] },
      { name: "Beta", status: "matched", speciesIds: ["s3"] },
      { name: "Gamma", status: "ambiguous", speciesIds: ["s5", "s6"] },
      { name: "Nope", status: "unmatched", speciesIds: [] },
    ]);
  });
});
