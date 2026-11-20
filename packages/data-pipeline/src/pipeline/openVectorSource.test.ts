import { describe, expect, it } from "vitest";
import {
  attributionText,
  decodePrve,
  encodePrve,
  mapTaxaToSpecies,
  needsWork,
  parseState,
  prveLicenseCode,
  prveVector,
  rankCandidates,
  vectorToBase64,
  type Candidate,
} from "./openVectorSource.js";

describe("prveLicenseCode", () => {
  // Every code iNaturalist's open data uses, plus what else might turn up in a licence column.
  it.each([
    ["CC0", 0],
    ["PD", 0],
    ["CC-BY", 1],
    ["CC-BY-4.0", 1],
    ["CC-BY-3.0", 2],
    ["cc-by", 1],
    ["CC-BY-NC", null],
    ["CC-BY-SA", null],
    ["CC-BY-ND", null],
    ["CC-BY-NC-SA", null],
    ["CC-BY-NC-ND", null],
    ["CC-BY-SA-3.0", null],
    ["C", null],
    ["GFDL", null],
    ["", null],
    ["unknown", null],
    [null, null],
    [undefined, null],
  ])("%s -> %s", (license, code) => {
    expect(prveLicenseCode(license)).toBe(code);
  });
});

describe("attributionText", () => {
  it("credits like iNaturalist does", () => {
    expect(attributionText("Ken-ichi Ueda", "CC-BY")).toBe("(c) Ken-ichi Ueda, some rights reserved (CC BY)");
    expect(attributionText("kueda", "CC0")).toBe("(c) kueda, no rights reserved (CC0)");
    expect(attributionText("kueda", "PD")).toBe("kueda, no known copyright restrictions (public domain)");
  });
});

describe("mapTaxaToSpecies", () => {
  const species = [
    { scientificName: "Corvus corax", inatTaxonId: 8010, synonyms: [] },
    { scientificName: "Curruca conspicillata", inatTaxonId: null, synonyms: ["Sylvia conspicillata"] },
    { scientificName: "Larus smithsonianus", inatTaxonId: 9000, synonyms: ["Larus argentatus smithsonianus"] },
    { scientificName: "Twin a", inatTaxonId: 77, synonyms: [] },
    { scientificName: "Twin b", inatTaxonId: 77, synonyms: [] },
    { scientificName: "Shared one", inatTaxonId: null, synonyms: ["Ambiguous name"] },
    { scientificName: "Shared two", inatTaxonId: null, synonyms: ["Ambiguous name"] },
  ];
  const map = mapTaxaToSpecies(species, [
    { taxonId: 8010, name: "Corvus corax" },
    { taxonId: 1, name: "Corvus corax" }, // a homonym: Corvus corax already matched by id
    { taxonId: 2, name: "Sylvia conspicillata" },
    { taxonId: 3, name: "Larus argentatus smithsonianus" }, // synonym of an id-matched species
    { taxonId: 9000, name: "Larus smithsonianus" },
    { taxonId: 77, name: "Twin b" },
    { taxonId: 4, name: "Ambiguous name" },
    { taxonId: 5, name: "Nobody here" },
  ]);
  it("matches by taxon id first", () => expect(map.get(8010)).toBe("Corvus corax"));
  it("matches by synonym when the species has no id match", () => expect(map.get(2)).toBe("Curruca conspicillata"));
  it("never pours a second taxon into an id-matched species", () => {
    expect(map.has(1)).toBe(false);
    expect(map.has(3)).toBe(false);
  });
  it("falls back to the name when an id is shared by two species", () => expect(map.get(77)).toBe("Twin b"));
  it("drops ambiguous names and unknown taxa", () => {
    expect(map.has(4)).toBe(false);
    expect(map.has(5)).toBe(false);
  });
});

describe("rankCandidates", () => {
  const c = (photoId: number, observerId: number, extra: Partial<Candidate> = {}): Candidate => ({
    photoId,
    extension: "jpg",
    license: "CC-BY",
    observerId,
    position: 0,
    latitude: 45,
    longitude: -75,
    observedOn: "2024-06-01",
    ...extra,
  });
  it("spreads picks over observers before taking a second photo from anyone", () => {
    const out = rankCandidates([c(1, 10), c(2, 10), c(3, 10), c(4, 20), c(5, 30)]);
    expect(
      out
        .slice(0, 3)
        .map((x) => x.observerId)
        .sort(),
    ).toEqual([10, 20, 30]);
    expect(out).toHaveLength(5);
  });
  it("prefers new places and seasons among new observers", () => {
    const out = rankCandidates([
      c(1, 10),
      c(2, 20), // same cell and season as 1
      c(3, 30, { latitude: -33, longitude: 151, observedOn: "2024-12-01" }),
    ]);
    expect(out.map((x) => x.photoId)).toEqual([1, 3, 2]);
  });
  it("never ranks a closed licence or an excluded photo", () => {
    const out = rankCandidates(
      [c(1, 10, { license: "CC-BY-NC" }), c(2, 20, { license: "CC-BY-SA" }), c(3, 30), c(4, 40)],
      new Set([4]),
    );
    expect(out.map((x) => x.photoId)).toEqual([3]);
  });
});

const photo = (species: string, photoId: number) =>
  JSON.stringify({
    t: "photo",
    species,
    taxonId: 1,
    photoId,
    photographer: "a",
    license: "CC0",
    attribution: "",
    sourceUrl: "",
    photoUrl: "",
    observedOn: null,
    latitude: null,
    longitude: null,
    v: "",
  });

describe("parseState", () => {
  it("resumes unfinished species, keeps their photos and never retries a photo", () => {
    const text = [
      photo("Corvus corax", 1),
      photo("Corvus corax", 2),
      JSON.stringify({ t: "done", species: "Corvus corax", photos: 2 }),
      photo("Pica pica", 3),
      JSON.stringify({ t: "failed", species: "Pica pica", photoId: 4, reason: "404" }),
      '{"t":"photo","species":"Pica pi', // cut off by a crash
    ].join("\n");
    const state = parseState(text);
    expect([...state.done]).toEqual(["Corvus corax"]);
    expect([...state.have]).toEqual([
      ["Corvus corax", 2],
      ["Pica pica", 1],
    ]);
    expect([...state.tried].sort()).toEqual([1, 2, 3, 4]);
  });
  it("ignores a photo written twice", () => {
    expect(parseState([photo("A b", 1), photo("A b", 1)].join("\n")).have.get("A b")).toBe(1);
  });
});

describe("needsWork", () => {
  const state = parseState(
    [
      photo("Short a", 1),
      JSON.stringify({ t: "done", species: "Short a", photos: 1 }),
      JSON.stringify({ t: "done", species: "Full b", photos: 0 }),
    ].join("\n"),
  );
  it("works on species not done yet", () => expect(needsWork(state, "New c", 0, 6, false)).toBe(true));
  it("reopens a done species that is short and has candidates", () =>
    expect(needsWork(state, "Short a", 2, 6, true)).toBe(true));
  it("counts Lifer's open gallery photos towards the target", () =>
    expect(needsWork(state, "Full b", 6, 6, true)).toBe(false));
  it("leaves a short species alone when it has no candidates", () =>
    expect(needsWork(state, "Short a", 0, 6, false)).toBe(false));
});

describe("PRVE", () => {
  it("writes the specification's worked example byte for byte", () => {
    const buf = encodePrve("clip-l14-v1", 2, [
      {
        species: "Corvus corax",
        licenseCode: 1,
        photographer: "A. Name",
        sourceUrl: "https://x.org/1",
        vector: Buffer.from(vectorToBase64([1.0, -0.5]), "base64"),
      },
    ]);
    expect(buf.toString("hex")).toBe(
      "5052564501000200010000000b00636c69702d6c31342d76310c00436f7276757320636f726178010700412e204e616d650f0068747470733a2f2f782e6f72672f31003c00b8",
    );
    const back = decodePrve(buf);
    expect(back.modelVersion).toBe("clip-l14-v1");
    expect(prveVector(back.rows[0])).toEqual([1, -0.5]);
  });
  it("refuses to write or read a closed licence", () => {
    const row = { species: "A b", licenseCode: 3, photographer: "", sourceUrl: "", vector: Buffer.alloc(4) };
    expect(() => encodePrve("m-v1", 2, [row])).toThrow(/closed/);
    const ok = encodePrve("m-v1", 2, [{ ...row, licenseCode: 0 }]);
    ok[ok.length - 4 - 2 - 2 - 1] = 4; // the licence byte
    expect(() => decodePrve(ok)).toThrow(/closed/);
  });
  it("refuses trailing bytes", () => {
    expect(() => decodePrve(Buffer.concat([encodePrve("m-v1", 2, []), Buffer.from([0])]))).toThrow(/past its last row/);
  });
});
