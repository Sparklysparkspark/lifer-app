// Culling marks as each app writes them. The sidecars in __fixtures__/cull are real-world shapes
// (see the comment at the top of each), read through the real bundled exiftool.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeExiftool } from "./exif.js";
import { cullDecision, cullMarksFromTags, mergeCullMarks, readCullMarks, readPairCullMarks } from "./cullMarks.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "cull");

let dir: string;
// A separate exiftool for writing test files, so the module's own read path is what's tested.
const writer = new ExifTool();

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-cull-"));
});
afterAll(async () => {
  await writer.end();
  await closeExiftool();
  rmSync(dir, { recursive: true, force: true });
});

async function jpeg(name: string): Promise<string> {
  const file = path.join(dir, name);
  await sharp({ create: { width: 32, height: 24, channels: 3, background: "#4a7" } })
    .jpeg()
    .toFile(file);
  return file;
}

/** A photo with this fixture as its sidecar, the way a RAW sits next to its .xmp. */
function rawWithSidecar(fixture: string, stem: string): string {
  const raw = path.join(dir, `${stem}.CR3`);
  writeFileSync(raw, "not really a raw");
  copyFileSync(path.join(FIXTURES, fixture), path.join(dir, `${stem}.xmp`));
  return raw;
}

describe("reading each culling app's sidecar", () => {
  it.each([
    ["lightroom-classic-reject.xmp", { verdict: "reject", label: "red" }],
    ["lightroom-classic-pick.xmp", { verdict: "pick", label: "green" }],
    ["bridge-reject.xmp", { verdict: "reject", label: "red" }],
    ["digikam-rejected.xmp", { verdict: "reject", label: "red" }],
    ["digikam-pending.xmp", { verdict: null, label: "purple" }],
    ["digikam-accepted.xmp", { verdict: "pick", label: null }],
    ["photomechanic-tagged.xmp", { verdict: "pick", label: null }],
    ["photomechanic-prefs-only.xmp", { verdict: "pick", label: null }],
    ["vireo-rejected.xmp", { verdict: "reject", label: null }],
    ["superpicky-pick.xmp", { verdict: "pick", label: "green" }],
    ["capture-one.xmp", { verdict: null, label: "yellow" }],
    ["custom-label.xmp", { verdict: null, label: null }],
  ])("%s", async (fixture, expected) => {
    const raw = rawWithSidecar(fixture, path.basename(fixture, ".xmp"));
    expect(await readCullMarks(raw)).toStrictEqual(expected);
  });
});

describe("reading marks embedded in a file", () => {
  it("reads xmp:Rating -1 inside a JPEG as rejected", async () => {
    const file = await jpeg("embedded-reject.jpg");
    await writer.write(file, { "XMP-xmp:Rating": -1, "XMP-xmp:Label": "Blue" } as never, {
      writeArgs: ["-overwrite_original"],
    });
    expect(await readCullMarks(file)).toStrictEqual({ verdict: "reject", label: "blue" });
  });

  it("reads a digiKam pick label inside a JPEG", async () => {
    const file = await jpeg("embedded-digikam.jpg");
    await writer.write(file, { "XMP-digiKam:PickLabel": 3 } as never, { writeArgs: ["-overwrite_original"] });
    expect(await readCullMarks(file)).toStrictEqual({ verdict: "pick", label: null });
  });

  it("doesn't take a Windows EXIF rating for xmp:Rating", async () => {
    const file = await jpeg("exif-rating.jpg");
    await writer.write(file, { "EXIF:Rating": 0 } as never, { writeArgs: ["-overwrite_original"] });
    expect(await readCullMarks(file)).toStrictEqual({ verdict: null, label: null });
  });

  it("finds nothing in a plain photo, and nothing (rather than an error) in an unreadable file", async () => {
    expect(await readCullMarks(await jpeg("plain.jpg"))).toStrictEqual({ verdict: null, label: null });
    expect(await readCullMarks(path.join(dir, "missing.jpg"))).toStrictEqual({ verdict: null, label: null });
  });

  it("never changes the file it reads", async () => {
    const file = await jpeg("untouched.jpg");
    await writer.write(file, { "XMP-xmp:Rating": -1 } as never, { writeArgs: ["-overwrite_original"] });
    const before = readFileSync(file);
    await readCullMarks(file);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("RAW+JPEG pairs", () => {
  it("applies a reject in the RAW's sidecar to the JPEG", async () => {
    const photo = await jpeg("pair1.jpg");
    const raw = rawWithSidecar("lightroom-classic-reject.xmp", "pair1-raw");
    expect(await readPairCullMarks(photo, raw)).toStrictEqual({ verdict: "reject", label: "red" });
  });

  it("applies a reject inside the JPEG to the pair, over a pick on the RAW", async () => {
    const photo = await jpeg("pair2.jpg");
    await writer.write(photo, { "XMP-xmp:Rating": -1 } as never, { writeArgs: ["-overwrite_original"] });
    const raw = rawWithSidecar("lightroom-classic-pick.xmp", "pair2-raw");
    expect(await readPairCullMarks(photo, raw)).toStrictEqual({ verdict: "reject", label: "green" });
  });

  it("finds the shared sidecar from the JPEG of the same stem", async () => {
    const photo = await jpeg("IMG_0007.jpg");
    rawWithSidecar("vireo-rejected.xmp", "IMG_0007");
    expect(await readPairCullMarks(photo, null)).toStrictEqual({ verdict: "reject", label: null });
  });
});

describe("cullMarksFromTags", () => {
  it("reads exiftool's printed values as well as its numbers", () => {
    expect(cullMarksFromTags({ Tagged: "Yes" })).toStrictEqual({ verdict: "pick", label: null });
    expect(cullMarksFromTags({ Tagged: "No", Prefs: "Tagged:1, ColorClass:2" })).toStrictEqual({
      verdict: null,
      label: null,
    });
    expect(cullMarksFromTags({ Prefs: "Tagged:1, ColorClass:2, Rating:3, FrameNum:000123" }).verdict).toBe("pick");
    expect(cullMarksFromTags({ Prefs: "0:2:3:000123" }).verdict).toBeNull();
    expect(cullMarksFromTags({ Rating: "-1" }).verdict).toBe("reject");
    expect(cullMarksFromTags({ Good: "False" }).verdict).toBe("reject");
    expect(cullMarksFromTags({ Good: true }).verdict).toBe("pick");
    expect(cullMarksFromTags({ PickLabel: "1 (Rejected)" }).verdict).toBe("reject");
  });

  it("treats unrated and unflagged as no verdict", () => {
    expect(cullMarksFromTags({ Rating: 0, Pick: 0, PickLabel: 0 })).toStrictEqual({ verdict: null, label: null });
  });

  it("lets a reject win over a pick in the same file", () => {
    expect(cullMarksFromTags({ Tagged: true, Rating: -1 }).verdict).toBe("reject");
  });

  it("maps label names in any case, Bridge's defaults and digiKam's numbers", () => {
    expect(cullMarksFromTags({ Label: "PURPLE" }).label).toBe("purple");
    expect(cullMarksFromTags({ Label: "To Do" }).label).toBe("purple");
    expect(cullMarksFromTags({ Label: "Approved" }).label).toBe("green");
    expect(cullMarksFromTags({ Label: "NoColor", ColorLabel: 2 }).label).toBe("orange");
    expect(cullMarksFromTags({ ColorLabel: 9 }).label).toBe("white");
    expect(cullMarksFromTags({ ColorLabel: 12 }).label).toBeNull();
  });
});

describe("mergeCullMarks", () => {
  it("keeps a reject from any file and the first label found", () => {
    expect(
      mergeCullMarks(
        { verdict: "pick", label: null },
        { verdict: "reject", label: "red" },
        { verdict: null, label: "blue" },
      ),
    ).toStrictEqual({ verdict: "reject", label: "red" });
    expect(mergeCullMarks({ verdict: null, label: null }, { verdict: "pick", label: null })).toStrictEqual({
      verdict: "pick",
      label: null,
    });
  });
});

describe("cullDecision", () => {
  const rejected = { verdict: "reject", label: null } as const;
  it("follows the option only for rejected photos", () => {
    expect(cullDecision(rejected, "skip")).toBe("skip");
    expect(cullDecision(rejected, "hide")).toBe("hide");
    expect(cullDecision(rejected, "ignore")).toBe("import");
    expect(cullDecision({ verdict: "pick", label: "red" }, "skip")).toBe("import");
    expect(cullDecision({ verdict: null, label: null }, "hide")).toBe("import");
  });
});
