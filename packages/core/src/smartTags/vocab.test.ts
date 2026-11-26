import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  allPaths,
  findSmartTagByPath,
  SMART_TAG_VOCAB,
  smartTagLabel,
  smartTagPath,
  spellingForLocale,
  validateVocab,
  type SmartTagVocab,
} from "@lifer/shared";

const SEED_CANDIDATES = [
  process.env.LIFER_CATALOG_SEED,
  new URL(
    "../../../../apps/desktop/src-tauri/resources-staging/catalog-seed/lifer-catalog-seed.sql.gz",
    import.meta.url,
  ).pathname,
  new URL("../../../data-pipeline/data/build/catalog-seed/lifer-catalog-seed.sql.gz", import.meta.url).pathname,
];
const seedPath = SEED_CANDIDATES.find((p) => p && existsSync(p));

/** Postgres text-array literal `{a,"b c"}` to its items. */
function arrayItems(raw: string): string[] {
  const body = raw.replace(/^\{|\}$/g, "");
  return [...body.matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, "$1"));
}

/** Common names, aliases, scientific names, codes and synonyms from the shipped catalog seed's COPY blocks. */
async function seedSpeciesNames(file: string): Promise<Set<string>> {
  const names = new Set<string>();
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let cols: string[] | null = null;
  let synonymCols: string[] | null = null;
  for await (const line of lines) {
    if (cols === null && synonymCols === null && !line.startsWith("COPY ")) continue;
    if (line.startsWith("COPY public.species ("))
      cols = line.slice(line.indexOf("(") + 1, line.indexOf(")")).split(", ");
    else if (line.startsWith("COPY public.species_synonyms (")) synonymCols = ["id", "species_id", "synonym_name"];
    else if (line.startsWith("COPY ")) {
      cols = null;
      synonymCols = null;
    } else if (line === "\\.") {
      if (synonymCols) break;
      cols = null;
    } else if (cols) {
      const f = line.split("\t");
      for (const c of ["scientific_name", "common_name", "ebird_code"]) {
        const v = f[cols.indexOf(c)];
        if (v && v !== "\\N") names.add(v);
      }
      const aliases = f[cols.indexOf("common_name_aliases")];
      if (aliases && aliases !== "\\N") arrayItems(aliases).forEach((a) => names.add(a));
    } else if (synonymCols) {
      const v = line.split("\t")[2];
      if (v && v !== "\\N") names.add(v);
    }
  }
  return names;
}

const clone = (): SmartTagVocab => structuredClone(SMART_TAG_VOCAB);
const problems = (v: SmartTagVocab, reserved: string[] = []) => validateVocab(v, reserved).join("\n");

describe("smart tags vocabulary v1", () => {
  it("passes every rule", () => {
    expect(validateVocab(SMART_TAG_VOCAB)).toEqual([]);
  });

  it("starts with only computed terms enabled and every CLIP or scene term unvalidated", () => {
    for (const t of SMART_TAG_VOCAB.terms) {
      expect(t.enabled, t.id).toBe(t.signal === "computed");
      expect(t.unvalidated, t.id).toBe(t.signal === "clip" || t.signal === "scene");
    }
  });

  it("follows the region for spelling, US when unknown", () => {
    for (const tag of ["en-US", "en-PH", "en", "", undefined, "garbage tag"])
      expect(spellingForLocale(tag), String(tag)).toBe("us");
    for (const tag of ["en-GB", "en-CA", "en-AU", "en-NZ", "en-IE", "en-IN", "en-ZA"])
      expect(spellingForLocale(tag), tag).toBe("uk");
  });

  it("resolves labels and paths in either spelling to one term id", () => {
    const gray = SMART_TAG_VOCAB.terms.find((t) => t.id === "color.gray-tones")!;
    expect(smartTagPath(gray, "us")).toBe("Color|Gray tones");
    expect(smartTagPath(gray, "uk")).toBe("Colour|Grey tones");
    expect(smartTagLabel(gray, "uk")).toBe("Grey tones");
    const behavior = SMART_TAG_VOCAB.terms.find((t) => t.id === "behavior.flying")!;
    expect(smartTagPath(behavior, "uk")).toBe("Behaviour|Flying");
    for (const path of ["Colour|Grey tones", "Color|Gray tones", "colour|grey tones"])
      expect(findSmartTagByPath(path)?.id).toBe("color.gray-tones");
    expect(findSmartTagByPath("Habitat|Nowhere")).toBeUndefined();
  });

  it("finds a term by either spelling in its synonyms", () => {
    const has = (id: string, word: string) => SMART_TAG_VOCAB.terms.find((t) => t.id === id)!.synonyms.includes(word);
    expect(
      has("color.colorful", "colourful") && has("color.gray-tones", "grey") && has("color.gray-tones", "gray"),
    ).toBe(true);
  });

  it("auto-creates the parents of nested paths", () => {
    const all = allPaths(["Things|Vehicle|Car"]);
    expect([...all]).toEqual(["Things", "Things|Vehicle", "Things|Vehicle|Car"]);
  });

  it("holds no em dash in the data file or the validator", () => {
    const dash = String.fromCharCode(0x2014);
    for (const f of ["vocab.json", "vocab.ts"]) {
      const url = new URL(`../../../shared/src/smartTags/${f}`, import.meta.url);
      expect(readFileSync(url, "utf8").includes(dash), f).toBe(false);
    }
  });

  it.skipIf(!seedPath)(
    "shares no name or synonym with a species in the shipped catalog seed",
    async () => {
      const names = await seedSpeciesNames(seedPath!);
      expect(names.size).toBeGreaterThan(10_000);
      expect(problems(SMART_TAG_VOCAB, [...names])).toBe("");
    },
    120_000,
  );
});

describe("validateVocab rules", () => {
  it("flags a duplicate id and a duplicate path", () => {
    const v = clone();
    v.terms[1].id = v.terms[0].id;
    v.terms[2].path = v.terms[0].path;
    expect(problems(v)).toMatch(/duplicate id/);
    expect(problems(v)).toMatch(/duplicate path/);
  });

  it("flags a term whose name or synonym is a species name, in any case or punctuation", () => {
    const v = clone();
    v.terms[0].synonyms.push("Great Blue-Heron");
    expect(problems(v, ["great blue heron"])).toMatch(/equals a catalog species name/);
    expect(problems(v, ["Ardea herodias"])).not.toMatch(/catalog/);
  });

  it("flags a word shared by two terms, even as a US/UK pair, but allows both spellings in one term", () => {
    const v = clone();
    const gray = v.terms.find((t) => t.id === "color.gray-tones")!;
    expect(gray.synonyms).toContain("grey");
    expect(problems(v)).toBe("");
    v.terms.find((t) => t.id === "color.black-tones")!.synonyms.push("grey");
    expect(problems(v)).toMatch(/also used by/);
  });

  it("flags a UK variant that differs by more than spelling, a UK canonical name, and a missing synonym", () => {
    const v = clone();
    const gray = v.terms.find((t) => t.id === "color.gray-tones")!;
    gray.uk = { name: "Silver tones" };
    expect(problems(v)).toMatch(/differ only by spelling/);
    gray.uk = { name: "Grey tones" };
    gray.synonyms = gray.synonyms.filter((x) => x !== "grey tones");
    expect(problems(v)).toMatch(/uk.name must also be a synonym/);
    v.terms.find((t) => t.id === "color.colorful")!.name = "Colourful";
    expect(problems(v)).toMatch(/name must be the US spelling/);
    v.groups.find((g) => g.id === "colour")!.rootUk = "Hue";
    expect(problems(v)).toMatch(/rootUk must differ/);
  });

  it("checks the UK spelling of a name against species names too", () => {
    const v = clone();
    expect(problems(v, ["grey tones"])).toMatch(/equals a catalog species name/);
  });

  it("flags a UK spelling in a prompt", () => {
    const v = clone();
    v.terms.find((t) => t.id === "color.colorful")!.prompts.push("a colourful photo");
    expect(problems(v)).toMatch(/UK spelling/);
  });

  it("flags a missing usage, too few prompts and a bad group", () => {
    const v = clone();
    v.terms[0].usage = "";
    const clip = v.terms.find((t) => t.signal === "clip")!;
    clip.prompts = clip.prompts.slice(0, 2);
    v.groups[0].none = false;
    const out = problems(v);
    expect(out).toMatch(/usage description missing/);
    expect(out).toMatch(/at least 3 distinct prompts/);
    expect(out).toMatch(/pick-one needs/);
  });

  it("flags an unvalidated term that starts enabled, and a leaf that is also a parent", () => {
    const v = clone();
    const clip = v.terms.find((t) => t.signal === "clip")!;
    clip.enabled = true;
    const parent = v.terms.find((t) => t.path === "Things|Vehicle|Car")!;
    v.terms.push({
      ...parent,
      id: "things.vehicle.car.suv",
      path: "Things|Vehicle|Car|Suv",
      name: "Suv",
      synonyms: [],
    });
    const out = problems(v);
    expect(out).toMatch(/cannot start enabled/);
    expect(out).toMatch(/both a tag and a parent/);
  });

  it("flags a bad label and an em dash", () => {
    const v = clone();
    v.terms[0].path = "Subject|Bird, big";
    v.terms[0].name = "Bird, big";
    v.terms[1].usage += ` ${String.fromCharCode(0x2014)}`;
    const out = problems(v);
    expect(out).toMatch(/pipe, comma/);
    expect(out).toMatch(/em dash/);
  });
});
