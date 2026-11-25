import { describe, expect, it } from "vitest";
import { encodeGainMapMetadata, gainMapXmp, parseGainMapMetadata, type GainMapMetadata } from "./gainMapMetadata.js";

const meta: GainMapMetadata = {
  baseHeadroom: 0,
  alternateHeadroom: 2.5,
  useBaseColourSpace: true,
  channels: [
    { min: -0.25, max: 2.5, gamma: 0.5, baseOffset: 1 / 64, alternateOffset: 1 / 64 },
    { min: -0.125, max: 2.25, gamma: 0.5, baseOffset: 1 / 64, alternateOffset: 1 / 64 },
    { min: 0, max: 2, gamma: 1, baseOffset: 1 / 64, alternateOffset: 1 / 64 },
  ],
};

describe("ISO 21496-1 gain map metadata", () => {
  it("reads back what it writes, three channels or one", () => {
    expect(parseGainMapMetadata(encodeGainMapMetadata(meta))).toEqual(meta);
    const one = { ...meta, useBaseColourSpace: false, channels: [meta.channels[0]!] };
    expect(parseGainMapMetadata(encodeGainMapMetadata(one))).toEqual(one);
  });

  it("reads the form with a denominator per value, as Lightroom writes it", () => {
    const fraction = (n: number, d: number, signed = false) => {
      const b = Buffer.alloc(8);
      if (signed) b.writeInt32BE(n, 0);
      else b.writeUInt32BE(n, 0);
      b.writeUInt32BE(d, 4);
      return b;
    };
    const block = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0x40]),
      fraction(0, 1),
      fraction(5, 2),
      fraction(-1, 4, true),
      fraction(5, 2, true),
      fraction(1, 2),
      fraction(1, 64, true),
      fraction(1, 64, true),
    ]);
    expect(parseGainMapMetadata(block)).toEqual({
      baseHeadroom: 0,
      alternateHeadroom: 2.5,
      useBaseColourSpace: true,
      channels: [{ min: -0.25, max: 2.5, gamma: 0.5, baseOffset: 1 / 64, alternateOffset: 1 / 64 }],
    });
  });

  it("refuses a block it can't read", () => {
    expect(parseGainMapMetadata(encodeGainMapMetadata(meta).subarray(0, 20))).toBeNull();
    const newer = encodeGainMapMetadata(meta);
    newer.writeUInt16BE(1, 0);
    expect(parseGainMapMetadata(newer)).toBeNull();
  });

  it("writes the hdrgm XMP with one value when the channels agree", () => {
    const xmp = gainMapXmp({ ...meta, channels: [meta.channels[2]!, meta.channels[2]!, meta.channels[2]!] });
    expect(xmp).toContain('hdrgm:GainMapMax="2"');
    expect(xmp).toContain('hdrgm:HDRCapacityMax="2.5"');
    expect(gainMapXmp(meta)).toContain('hdrgm:GainMapMax="2.5, 2.25, 2"');
  });
});
