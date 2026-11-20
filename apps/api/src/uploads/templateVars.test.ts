import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileNamePreset, keepsOriginalName, renderTemplate, unknownTemplateVariables } from "@lifer/shared";
import { creditTags, type FileCredits } from "./exif.js";
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
  const none: FileCredits = {
    creator: null,
    copyright: null,
    credit: null,
    usageTerms: null,
    caption: null,
    captionIsLifers: false,
  };
  const wanted = {
    creator: "Jane Doe",
    copyright: "© 2026 Jane Doe",
    credit: "",
    usageTerms: "",
    caption: "Osprey, Alberta",
    replaceExisting: false,
  };

  it("fills empty fields, embedded in IPTC and EXIF too", () => {
    const tags = creditTags(none, wanted, "embedded");
    expect(tags["XMP-dc:Creator"]).toEqual(["Jane Doe"]);
    expect(tags["IPTC:CopyrightNotice"]).toBe("© 2026 Jane Doe");
    expect(tags["XMP-dc:Description"]).toBe("Osprey, Alberta");
    expect(tags["XMP-photoshop:Credit"]).toBeUndefined();
    expect(creditTags(none, wanted, "sidecar")["IPTC:By-line"]).toBeUndefined();
  });

  it("never replaces the file's own creator, copyright or caption unless asked", () => {
    const theirs = { ...none, creator: "Someone", copyright: "© Someone", caption: "Typed in Lightroom" };
    expect(creditTags(theirs, wanted, "embedded")).toEqual({});
    const replaced = creditTags(theirs, { ...wanted, replaceExisting: true }, "embedded");
    expect(replaced["XMP-dc:Creator"]).toEqual(["Jane Doe"]);
    // A caption typed elsewhere is kept even then.
    expect(replaced["XMP-dc:Description"]).toBeUndefined();
  });

  it("updates its own caption and writes nothing when the file already matches", () => {
    const lifers = { ...none, caption: "Heron, Alberta", captionIsLifers: true };
    expect(creditTags(lifers, wanted, "sidecar")["XMP-dc:Description"]).toBe("Osprey, Alberta");
    const same = {
      ...none,
      creator: "Jane Doe",
      copyright: "© 2026 Jane Doe",
      caption: "Osprey, Alberta",
      captionIsLifers: true,
    };
    expect(creditTags(same, wanted, "embedded")).toEqual({});
  });
});
