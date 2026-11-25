// Sidecar names, sidecar-only writes and linked folder sidecars, round-tripped through the real
// bundled exiftool on generated files in a temp folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// keywordsToKeep asks the catalog which keywords are species names; answer for this one species.
vi.mock("@lifer/core/db.js", () => ({
  pool: {
    query: (_sql: string, params: unknown[] = []) => {
      const known = new Set(["bald eagle", "haliaeetus leucocephalus"]);
      const words = Array.isArray(params[0]) ? (params[0] as string[]) : [];
      return Promise.resolve({ rows: words.filter((k) => known.has(k)).map((k) => ({ k })), rowCount: 0 });
    },
  },
}));

import { closeExiftool, writeCaptureMetadata, type XmpSidecarData } from "./exif.js";
import { writeOriginalMetadata } from "./fileWriting.js";
import {
  DEFAULT_FILE_WRITE,
  fullSidecar,
  moveSidecars,
  sidecarsToWrite,
  stemSidecar,
  type FileWriteSettings,
} from "./sidecarNames.js";

let dir: string;
const et = new ExifTool({ maxProcs: 1 });
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "lifer-sidecars-"));
});
afterAll(async () => {
  await et.end();
  await closeExiftool();
  rmSync(dir, { recursive: true, force: true });
});

const data: XmpSidecarData = {
  species: [{ commonName: "Bald Eagle", scientificName: "Haliaeetus leucocephalus", taxonClass: "aves", family: null }],
  namingStyles: [],
  rating: 4,
  isCover: false,
  takenAt: null,
  lat: 49.1,
  lon: -123.2,
  cameraModel: null,
  lens: null,
  focalLengthMm: null,
  aperture: null,
  shutter: null,
  iso: null,
};
const settings = (patch: Partial<FileWriteSettings>): FileWriteSettings => ({ ...DEFAULT_FILE_WRITE, ...patch });
const tags = async (file: string) => (await et.read(file)) as Record<string, unknown>;
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

let n = 0;
function folder(): string {
  const d = path.join(dir, `case-${++n}`);
  mkdirSync(d);
  return d;
}
function fakeRaw(d: string): string {
  const raw = path.join(d, "IMG_0001.CR3");
  writeFileSync(raw, Buffer.from("not really a raw"));
  return raw;
}
async function jpeg(d: string): Promise<string> {
  const file = path.join(d, "IMG_0002.JPG");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "#456" } })
    .jpeg()
    .toFile(file);
  return file;
}

describe("sidecarsToWrite", () => {
  it("picks names by the setting, keeps an existing stem sidecar in step, and gives a JPEG its full name", async () => {
    const d = folder();
    const raw = fakeRaw(d);
    expect(await sidecarsToWrite(raw, false, "stem")).toEqual([stemSidecar(raw)]);
    expect(await sidecarsToWrite(raw, false, "full")).toEqual([fullSidecar(raw)]);
    expect(await sidecarsToWrite(raw, false, "both")).toEqual([stemSidecar(raw), fullSidecar(raw)]);
    writeFileSync(stemSidecar(raw), "");
    expect(await sidecarsToWrite(raw, false, "full")).toEqual([fullSidecar(raw), stemSidecar(raw)]);
    expect(await sidecarsToWrite(path.join(d, "a.jpg"), true, "stem")).toEqual([path.join(d, "a.jpg.xmp")]);
  });
});

describe("writeCaptureMetadata with file writing settings", () => {
  it("writes the same keywords into both RAW sidecar names and leaves the RAW alone", async () => {
    const raw = fakeRaw(folder());
    await writeCaptureMetadata(raw, data, settings({ sidecarNames: "both" }));
    for (const sidecar of [stemSidecar(raw), fullSidecar(raw)]) {
      const t = await tags(sidecar);
      expect(list(t.Subject)).toEqual(expect.arrayContaining(["Bald Eagle", "Haliaeetus leucocephalus"]));
      expect(t.Rating).toBe(4);
    }
    expect(readFileSync(raw, "utf8")).toBe("not really a raw");
  });

  it("writes only IMG_0001.xmp by default, as before", async () => {
    const raw = fakeRaw(folder());
    await writeCaptureMetadata(raw, data);
    expect(existsSync(stemSidecar(raw))).toBe(true);
    expect(existsSync(fullSidecar(raw))).toBe(false);
  });

  it("leaves a JPEG's bytes untouched and writes IMG_0002.JPG.xmp when in-file writes are off", async () => {
    const file = await jpeg(folder());
    const before = readFileSync(file);
    await writeCaptureMetadata(file, data, settings({ insideFiles: false }));
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(list((await tags(fullSidecar(file))).Subject)).toContain("Bald Eagle");
    expect(existsSync(stemSidecar(file))).toBe(false);
  });

  it("writes inside a JPEG when in-file writes are on", async () => {
    const file = await jpeg(folder());
    await writeCaptureMetadata(file, data, settings({ insideFiles: true }));
    expect(list((await tags(file)).Keywords)).toContain("Bald Eagle");
    expect(existsSync(fullSidecar(file))).toBe(false);
  });
});

describe("writeOriginalMetadata for linked files", () => {
  const on = settings({ linkedFolders: true });

  it("writes nothing next to a linked file unless the user opted in", async () => {
    const raw = fakeRaw(folder());
    await writeOriginalMetadata(raw, false, data, DEFAULT_FILE_WRITE);
    expect(existsSync(stemSidecar(raw))).toBe(false);
  });

  it("creates a sidecar marked as Lifer's with keywords only, never touching the file", async () => {
    const file = await jpeg(folder());
    const before = readFileSync(file);
    await writeOriginalMetadata(file, false, data, on);
    expect(readFileSync(file).equals(before)).toBe(true);
    const t = await tags(fullSidecar(file));
    expect(t.CreatorTool).toBe("Lifer");
    expect(list(t.Subject)).toContain("Bald Eagle");
    expect(t.Rating).toBeUndefined();
    expect(t.GPSLatitude).toBeUndefined();
    // A later write updates Lifer's own sidecar.
    await writeOriginalMetadata(file, false, { ...data, tags: ["perched"] }, on);
    expect(list((await tags(fullSidecar(file))).Subject)).toContain("perched");
  });

  it("leaves a sidecar another app made alone", async () => {
    const raw = fakeRaw(folder());
    await et.write(stemSidecar(raw), { "XMP-dc:Subject": ["Mine"], "XMP-xmp:CreatorTool": "Adobe Lightroom" } as never);
    const before = readFileSync(stemSidecar(raw), "utf8");
    await writeOriginalMetadata(raw, false, data, on);
    expect(readFileSync(stemSidecar(raw), "utf8")).toBe(before);
  });

  it("does nothing for a linked file that isn't there (a disconnected drive)", async () => {
    const d = folder();
    await writeOriginalMetadata(path.join(d, "gone.CR3"), false, data, on);
    expect(existsSync(path.join(d, "gone.xmp"))).toBe(false);
  });
});

describe("moveSidecars", () => {
  it("moves each existing sidecar under its matching name and never over a file already there", async () => {
    const from = fakeRaw(folder());
    writeFileSync(stemSidecar(from), "stem");
    writeFileSync(fullSidecar(from), "full");
    const to = path.join(folder(), "Eagle_0001.CR3");
    writeFileSync(fullSidecar(to), "already here");
    const moved: string[] = [];
    await moveSidecars(from, to, false, async (src, dest) => {
      moved.push(`${path.basename(src)}>${path.basename(dest)}`);
    });
    expect(moved).toEqual(["IMG_0001.xmp>Eagle_0001.xmp"]);
  });
});
