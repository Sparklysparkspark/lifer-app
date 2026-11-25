import sharp, { type Sharp } from "sharp";
import { describe, expect, it } from "vitest";
import { parseGainMapMetadata, type GainMapMetadata } from "./gainMapMetadata.js";
import { writeUltraHdr } from "./ultraHdr.js";
import { isoBlock } from "./__fixtures__/images.js";

const meta: GainMapMetadata = {
  baseHeadroom: 0,
  alternateHeadroom: 2,
  useBaseColourSpace: true,
  channels: [{ min: 0, max: 2, gamma: 1, baseOffset: 1 / 64, alternateOffset: 1 / 64 }],
};

describe("writeUltraHdr", () => {
  it("joins the base and gain map so a gain map reader finds both", async () => {
    const base = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const gain = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer();
    const icc = Buffer.from("not really a profile");
    const out = writeUltraHdr(base, gain, meta, icc);

    const read = await sharp(out).metadata();
    expect([read.width, read.height]).toEqual([40, 20]);
    expect(read.icc?.equals(icc)).toBe(true);
    expect(read.gainMap).toBeTruthy();

    // The MPF index points at the gain map's first byte, counted from its own header.
    const mpf = out.indexOf("MPF\0") + 4;
    const entry2 = mpf + 8 + 2 + 3 * 12 + 4 + 16;
    const start = mpf + out.readUInt32BE(entry2 + 8);
    expect(out.readUInt16BE(start)).toBe(0xffd8);
    expect(out.readUInt32BE(entry2 + 4)).toBe(out.length - start);
    expect(out.readUInt32BE(mpf + 8 + 2 + 3 * 12 + 4 + 4)).toBe(start);

    // The primary says it has a gain map; the gain map carries the values.
    expect(isoBlock(out)?.length).toBe(4);
    expect(parseGainMapMetadata(isoBlock(out.subarray(start))!)).toEqual(meta);
    expect(out.subarray(start).toString("latin1")).toContain('hdrgm:GainMapMax="2"');
  });

  it("survives being resized by a gain map aware encoder", async () => {
    const base = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
    const gain = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer();
    const keep = sharp(writeUltraHdr(base, gain, meta)) as Sharp & { keepGainMap(): Sharp };
    const resized = await keep.keepGainMap().resize({ width: 20 }).jpeg().toBuffer();
    expect((await sharp(resized).metadata()).gainMap).toBeTruthy();
  });
});
