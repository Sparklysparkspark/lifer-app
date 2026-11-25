// Fixtures are synthetic grey ramps (see __fixtures__/images.ts). gainmap.avif was made from two of
// them with libavif's `avifgainmaputil combine base.png alt-pq.png`, and pq.jxl with `cjxl alt-pq.png`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Sharp } from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { detectHdr, iccCicp } from "./detect.js";
import { parseGainMapMetadata } from "./gainMapMetadata.js";
import { HDR_SIDE, renderHdr } from "./render.js";
import { writeUltraHdr } from "./ultraHdr.js";
import { hdrPng, iccWithCicp, isoBlock, sdrPng } from "./__fixtures__/images.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "__fixtures__", name);
const coreFixture = (name: string) => path.join(here, "../../../../../packages/core/src/uploads/__fixtures__", name);
const dir = mkdtempSync(path.join(tmpdir(), "lifer-hdr-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function save(name: string, bytes: Buffer): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}

/** Detects and renders the file; the rendition's size and the headroom its gain map states. */
async function rendition(file: string) {
  const source = await detectHdr(file);
  const bytes = source && (await renderHdr(file, source));
  if (!bytes) return null;
  const meta = await sharp(bytes).metadata();
  const gain = meta.gainMap ? parseGainMapMetadata(isoBlock(meta.gainMap.image)!) : null;
  return { source, width: meta.width, height: meta.height, headroom: gain?.alternateHeadroom ?? null, exif: meta.exif };
}

// A 1,000 nit peak over 203 nit SDR white, in stops.
const STOPS_1000_NITS = Math.log2(1000 / 203);

describe("HDR renditions", () => {
  it("keeps an Ultra HDR JPEG's gain map, at display size and without its metadata", async () => {
    const shaped = sharp({
      create: { width: HDR_SIDE + 100, height: 400, channels: 3, background: "#888" },
    }) as Sharp & {
      withGainMap(): Sharp;
    };
    const file = save(
      "ultra.jpg",
      await shaped
        .withGainMap()
        .withExif({ IFD0: { Artist: "Someone" } })
        .jpeg()
        .toBuffer(),
    );
    const made = await rendition(file);
    expect(made?.source).toEqual({ kind: "gainMap", container: "jpeg" });
    expect(made?.width).toBe(HDR_SIDE);
    expect(made?.headroom).not.toBeNull();
    expect(made?.exif?.toString("latin1") ?? "").not.toContain("Someone");
  });

  it("makes a gain map for PQ and HLG PNGs, from a cICP chunk or an ICC profile", async () => {
    for (const [name, png, transfer] of [
      ["pq.png", await hdrPng("pq"), 16],
      ["hlg.png", await hdrPng("hlg"), 18],
      ["pq-icc.png", await hdrPng("pq", { cicpIn: "icc" }), 16],
    ] as const) {
      const made = await rendition(save(name, png));
      expect(made?.source).toEqual({ kind: "signal", container: "png", transfer, primaries: 9 });
      expect([made?.width, made?.height]).toEqual([64, 16]);
      expect(made?.headroom).toBeCloseTo(STOPS_1000_NITS, 0);
    }
  });

  it("reads a PQ AVIF's colour from its nclx box", async () => {
    const png = await hdrPng("pq");
    const avif = await sharp(png).avif({ bitdepth: 10, lossless: true }).toBuffer();
    // sharp writes BT.709; restate it as BT.2020 PQ, as a camera's HDR AVIF says.
    const colr = avif.indexOf("colrnclx") + 8;
    avif.writeUInt16BE(9, colr);
    avif.writeUInt16BE(16, colr + 2);
    const made = await rendition(save("pq.avif", avif));
    expect(made?.source).toEqual({ kind: "signal", container: "avif", transfer: 16, primaries: 9 });
    expect(made?.headroom).toBeCloseTo(STOPS_1000_NITS, 0);
  });

  it("re-encodes an AVIF gain map with the file's own metadata", async () => {
    const made = await rendition(fixture("gainmap.avif"));
    expect(made?.source).toEqual({ kind: "gainMap", container: "avif" });
    expect([made?.width, made?.height]).toEqual([64, 16]);
    expect(made?.headroom).toBeCloseTo(STOPS_1000_NITS, 1);
  });

  it("decodes a PQ JPEG XL in its own colours", async () => {
    const made = await rendition(fixture("pq.jxl"));
    expect(made?.source).toEqual({ kind: "jxl" });
    expect(made?.headroom).toBeCloseTo(STOPS_1000_NITS, 0);
  });

  it("makes none for SDR photos, HDR without highlights, or HEIC", async () => {
    expect(await rendition(save("sdr.png", await sdrPng()))).toBeNull();
    expect(await rendition(save("dim.png", await hdrPng("pq", { peakNits: 150 })))).toBeNull();
    expect(
      await rendition(
        save(
          "plain.jpg",
          await sharp(await sdrPng())
            .jpeg()
            .toBuffer(),
        ),
      ),
    ).toBeNull();
    expect(await rendition(coreFixture("tiny.jxl"))).toBeNull();
    expect(await detectHdr(coreFixture("p3.heic"))).toBeNull();
    expect(await detectHdr(coreFixture("p3.avif"))).toBeNull();
    expect(await detectHdr(path.join(dir, "missing.jpg"))).toBeNull();
  });

  it("reads on when a JPEG's header runs past the first read", async () => {
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toBuffer();
    const meta = {
      baseHeadroom: 0,
      alternateHeadroom: 1,
      useBaseColourSpace: true,
      channels: [{ min: 0, max: 1, gamma: 1, baseOffset: 0, alternateOffset: 0 }],
    };
    // A large ICC profile pushes the MPF index past 64 KB.
    const file = save("long-header.jpg", writeUltraHdr(plain, plain, meta, Buffer.alloc(65_000)));
    expect(await detectHdr(file)).toEqual({ kind: "gainMap", container: "jpeg" });
  });

  it("reads the cicp tag of an ICC profile", () => {
    expect(iccCicp(iccWithCicp(9, 18))).toEqual({ primaries: 9, transfer: 18 });
    expect(iccCicp(Buffer.alloc(200))).toBeNull();
    expect(iccCicp(undefined)).toBeNull();
  });
});
