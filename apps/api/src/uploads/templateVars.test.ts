import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTION_PRESETS,
  DEFAULT_METADATA_FIELDS,
  fileNamePreset,
  keepsOriginalName,
  renderFields,
  renderKeywords,
  renderTemplate,
  unknownTemplateVariables,
  type WriteRule,
} from "@lifer/shared";
import { creditTags, keywordPlan, textFieldPlan, type FileCredits } from "./exif.js";
import { nextSeq, renderFileStem, stemPattern, templatedFileName } from "./templateVars.js";

const full = {
  species: "Osprey",
  scientific: "Pandion haliaetus",
  place: "Pigeon Lake",
  region: "Alberta",
  country: "Canada",
  date: "2026-05-03",
  year: "2026",
};
const CAPTION = "{species} ({scientific}), {place}, {region}, {date}";

describe("renderTemplate", () => {
  it("fills every variable", () => {
    expect(renderTemplate(CAPTION, full)).toBe("Osprey (Pandion haliaetus), Pigeon Lake, Alberta, 2026-05-03");
    expect(renderTemplate("© {year} Jane Doe", full)).toBe("© 2026 Jane Doe");
  });

  it("drops empty values without dangling commas or brackets", () => {
    expect(renderTemplate(CAPTION, { ...full, scientific: null })).toBe("Osprey, Pigeon Lake, Alberta, 2026-05-03");
    expect(renderTemplate(CAPTION, { ...full, place: "" })).toBe("Osprey (Pandion haliaetus), Alberta, 2026-05-03");
    expect(renderTemplate(CAPTION, { ...full, species: null })).toBe(
      "(Pandion haliaetus), Pigeon Lake, Alberta, 2026-05-03",
    );
    expect(renderTemplate(CAPTION, { species: "Osprey" })).toBe("Osprey");
    expect(renderTemplate(CAPTION, { date: "2026-05-03" })).toBe("2026-05-03");
    expect(renderTemplate("{date}_{species}_{seq}", { date: "2026-05-03", seq: "0001" })).toBe("2026-05-03_0001");
    expect(renderTemplate("{species} - {place} - {region}", { species: "Osprey", region: "Alberta" })).toBe(
      "Osprey - Alberta",
    );
    expect(renderTemplate("© {year} Jane Doe", {})).toBe("© Jane Doe");
  });

  it("gives nothing when every variable is empty", () => {
    expect(renderTemplate(CAPTION, {})).toBe("");
    expect(renderTemplate("{place}.", {})).toBe("");
  });

  it("keeps plain text and unknown variables as typed, and cleans values", () => {
    expect(renderTemplate("Jane Doe", {})).toBe("Jane Doe");
    expect(renderTemplate("{nope} {species}", full)).toBe("{nope} Osprey");
    expect(renderTemplate("{species}", { species: "  Bald\n\tEagle\u0000 " })).toBe("Bald Eagle");
  });

  it("handles very long values", () => {
    const long = "x".repeat(5000);
    expect(renderTemplate("{place}, {region}", { place: long, region: "Alberta" })).toBe(`${long}, Alberta`);
  });
});

describe("template validation and presets", () => {
  it("finds unknown variables", () => {
    expect(unknownTemplateVariables("{species}_{seq}_{bogus}")).toEqual(["bogus"]);
    expect(unknownTemplateVariables("{seq}", ["species"])).toEqual(["seq"]);
  });

  it("recognizes presets", () => {
    expect(fileNamePreset("{date}_{species}_{seq}")).toBe("dateSpecies");
    expect(fileNamePreset("{species}")).toBe("custom");
    expect(keepsOriginalName("{original}")).toBe(true);
    expect(keepsOriginalName("")).toBe(true);
    expect(keepsOriginalName("{date}_{original}")).toBe(false);
  });
});

describe("file names", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("sanitizes for every filesystem", () => {
    expect(renderFileStem("{species}_{place}", { species: 'Owl: "Great/Horned"?', place: "Lake*. " })).toBe(
      "Owl GreatHorned_Lake",
    );
  });

  it("caps very long names below the filesystem limit", () => {
    const stem = renderFileStem("{species}", { species: "é".repeat(500) })!;
    expect(Buffer.byteLength(stem)).toBeLessThanOrEqual(180);
  });

  it("is null when nothing is left", () => {
    expect(renderFileStem("{species}", {})).toBeNull();
    expect(renderFileStem("{species}", { species: "???" })).toBeNull();
  });

  it("numbers per name in a folder, and recognizes names it gave", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "lifer-seq-"));
    const values = { date: "2026-05-03", species: "Osprey" };
    const t = "{date}_{species}_{seq}";
    expect(await nextSeq(dir, t, values)).toBe("0001");
    await writeFile(path.join(dir, "2026-05-03_Osprey_0007.jpg"), "");
    await writeFile(path.join(dir, "2026-05-03_Osprey_0009-2.jpg"), "");
    await writeFile(path.join(dir, "2026-05-03_Heron_0042.jpg"), "");
    expect(await nextSeq(dir, t, values)).toBe("0010");
    expect(await templatedFileName(t, dir, values, ".CR3")).toBe("2026-05-03_Osprey_0010.CR3");
    const pattern = stemPattern(t, values)!;
    expect(pattern.test("2026-05-03_Osprey_0003")).toBe(true);
    expect(pattern.test("2026-05-03_Osprey_0003-2")).toBe(true);
    expect(pattern.test("IMG_4411")).toBe(false);
  });

  it("keeps the camera's name by default", async () => {
    expect(await templatedFileName("{original}", "/nowhere", { original: "IMG_1" }, ".jpg")).toBeNull();
  });
});

describe("creditTags", () => {
  const none: FileCredits = { creator: null, copyright: null, credit: null, usageTerms: null };
  const wanted = {
    creator: "Jane Doe",
    copyright: "© 2026 Jane Doe",
    credit: "",
    usageTerms: "",
    replaceExisting: false,
  };

  it("fills empty fields, embedded in IPTC and EXIF too", () => {
    const tags = creditTags(none, wanted, "embedded");
    expect(tags["XMP-dc:Creator"]).toEqual(["Jane Doe"]);
    expect(tags["IPTC:CopyrightNotice"]).toBe("© 2026 Jane Doe");
    expect(tags["XMP-photoshop:Credit"]).toBeUndefined();
    expect(creditTags(none, wanted, "sidecar")["IPTC:By-line"]).toBeUndefined();
  });

  it("never replaces the file's own creator or copyright unless asked", () => {
    const theirs = { ...none, creator: "Someone", copyright: "© Someone" };
    expect(creditTags(theirs, wanted, "embedded")).toEqual({});
    const replaced = creditTags(theirs, { ...wanted, replaceExisting: true }, "embedded");
    expect(replaced["XMP-dc:Creator"]).toEqual(["Jane Doe"]);
  });

  it("writes nothing when the file already matches", () => {
    expect(creditTags({ ...none, creator: "Jane Doe", copyright: "© 2026 Jane Doe" }, wanted, "embedded")).toEqual({});
  });
});

describe("textFieldPlan", () => {
  const w = (rule: WriteRule, value = "Osprey") => ({ value, rule });

  it("fills an empty field under every writing rule, and never writes when off or empty", () => {
    for (const rule of ["fillEmpty", "replace", "append"] as const)
      expect(textFieldPlan("", w(rule), undefined, false)).toEqual({ value: "Osprey", own: "Osprey", whole: true });
    expect(textFieldPlan("", w("off"), undefined, false)).toBeNull();
    expect(textFieldPlan("Heron", w("replace", ""), "Heron", false)).toBeNull();
  });

  it("replaces only Lifer's own value, by its record, else by the in-file marker", () => {
    expect(textFieldPlan("Heron", w("replace"), "Heron", false)).toMatchObject({ value: "Osprey" });
    // Edited after Lifer wrote it: kept, even when the marker says Lifer's.
    expect(textFieldPlan("Heron at dusk", w("replace"), "Heron", true)).toBe("edited");
    expect(textFieldPlan("Heron", w("replace"), undefined, true)).toMatchObject({ value: "Osprey" });
    expect(textFieldPlan("Typed elsewhere", w("replace"), undefined, false)).toBe("edited");
    expect(textFieldPlan("Osprey", w("replace"), undefined, false)).toMatchObject({ value: "Osprey" });
  });

  it("fills only empty fields with fillEmpty, its own earlier value included", () => {
    expect(textFieldPlan("Heron", w("fillEmpty"), "Heron", false)).toBeNull();
  });

  it("appends after the file's own text once, swapping Lifer's earlier addition", () => {
    const first = textFieldPlan("My trip", w("append"), undefined, false);
    expect(first).toEqual({ value: "My trip Osprey", own: "Osprey", whole: false });
    expect(textFieldPlan("My trip Osprey", w("append"), "Osprey", false)).toMatchObject({ value: "My trip Osprey" });
    expect(textFieldPlan("My trip Heron", w("append"), "Heron", false)).toMatchObject({ value: "My trip Osprey" });
    expect(textFieldPlan("My trip Osprey", w("append"), undefined, false)).toMatchObject({ value: "My trip Osprey" });
    // Lifer's addition edited away: left alone.
    expect(textFieldPlan("My trip, rewritten", w("append"), "Heron", false)).toBe("edited");
  });
});

describe("keywordPlan", () => {
  const want = (values: string[], rule: WriteRule = "replace") => ({ values, rule });

  it("adds extra keywords, and swaps Lifer's earlier ones while they're all still there", () => {
    expect(keywordPlan({ flat: ["sunset"], all: ["sunset"] }, want(["Canada"]), undefined)).toEqual({
      add: ["Canada"],
      drop: [],
      own: ["Canada"],
    });
    const kept = { flat: ["sunset", "Canada"], all: ["sunset", "Canada"] };
    expect(keywordPlan(kept, want(["Alberta"]), ["Canada"])).toEqual({
      add: ["Alberta"],
      drop: ["Canada"],
      own: ["Alberta"],
    });
    // Someone removed Lifer's keyword: the extras are left as they are.
    expect(keywordPlan({ flat: ["sunset"], all: ["sunset"] }, want(["Alberta"]), ["Canada"])).toBe("edited");
  });

  it("never claims a keyword the file had before", () => {
    const kept = { flat: ["Canada"], all: ["Canada"] };
    expect(keywordPlan(kept, want(["Canada"]), undefined)).toEqual({ add: [], drop: [], own: [] });
  });

  it("follows fillEmpty, append and off", () => {
    expect(keywordPlan({ flat: ["sunset"], all: ["sunset"] }, want(["Canada"], "fillEmpty"), undefined)).toBeNull();
    expect(keywordPlan({ flat: [], all: [] }, want(["Canada"], "fillEmpty"), undefined)).toMatchObject({
      add: ["Canada"],
    });
    expect(keywordPlan({ flat: ["Canada"], all: ["Canada"] }, want(["Alberta"], "append"), ["Canada"])).toEqual({
      add: ["Alberta"],
      drop: [],
      own: ["Canada", "Alberta"],
    });
    expect(keywordPlan({ flat: [], all: [] }, want(["Canada"], "off"), undefined)).toBeNull();
  });
});

describe("field templates", () => {
  const values = {
    species: "Griffon Vulture",
    names: "Griffon Vulture, Osprey",
    count: "2",
    longdate: "12 May 2024",
    focal: "600mm",
    aperture: "f/4",
    family: "Accipitridae",
    country: "Spain",
  };

  it("defaults to what Lifer wrote before templates: the names as the title, nothing else", () => {
    const r = renderFields(DEFAULT_METADATA_FIELDS, values);
    expect(r).toEqual({ title: "Griffon Vulture, Osprey", headline: "", caption: "", keywords: [] });
  });

  it("renders the caption preset, dropping wording around a missing value", () => {
    expect(renderTemplate(CAPTION_PRESETS.imageOf, values)).toBe(
      "An image of a Griffon Vulture taken on 12 May 2024 with a 600mm f/4",
    );
    expect(renderTemplate(CAPTION_PRESETS.imageOf, { ...values, species: "Osprey", focal: null })).toBe(
      "An image of an Osprey taken on 12 May 2024",
    );
    expect(renderTemplate("a {species}", { species: "European Robin" })).toBe("a European Robin");
    expect(renderTemplate("a {species}", { species: "Upland Sandpiper" })).toBe("an Upland Sandpiper");
  });

  it("keeps square brackets that aren't doubled as they were", () => {
    expect(renderTemplate("{species} [{family}]", values)).toBe("Griffon Vulture [Accipitridae]");
  });

  it("splits extra keywords, each filled on its own", () => {
    expect(renderKeywords("{family}, {place}; {country}, Wildlife, {family}", values)).toEqual([
      "Accipitridae",
      "Spain",
      "Wildlife",
    ]);
  });
});
