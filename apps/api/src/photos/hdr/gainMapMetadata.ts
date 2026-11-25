// ISO 21496-1 gain map metadata: the binary block HDR JPEG, AVIF ('tmap') and JPEG XL ('jhgm')
// files share, and the older Adobe hdrgm XMP form of the same values. Gains and headrooms are log2.

export interface GainMapChannel {
  min: number;
  max: number;
  gamma: number;
  baseOffset: number;
  alternateOffset: number;
}

export interface GainMapMetadata {
  baseHeadroom: number;
  alternateHeadroom: number;
  /** One entry, or three (red, green, blue). */
  channels: GainMapChannel[];
  /** The gain map applies in the base image's colour space. */
  useBaseColourSpace: boolean;
}

const MULTI_CHANNEL = 0x80;
const BASE_COLOUR_SPACE = 0x40;
const COMMON_DENOMINATOR = 0x08;
const DENOMINATOR = 1 << 20;

/** Parses the binary block; null when it isn't one this reader knows. */
export function parseGainMapMetadata(data: Uint8Array): GainMapMetadata | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 0;
  const u16 = () => ((at += 2), view.getUint16(at - 2));
  const u32 = () => ((at += 4), view.getUint32(at - 4));
  const s32 = () => ((at += 4), view.getInt32(at - 4));
  try {
    if (u16() !== 0) return null; // minimum_version
    u16(); // writer_version
    const flags = data[at++]!;
    const count = flags & MULTI_CHANNEL ? 3 : 1;
    const common = (flags & COMMON_DENOMINATOR) !== 0;
    const denom = common ? u32() : 0;
    const signed = () => (common ? s32() / denom : s32() / u32());
    const unsigned = () => (common ? u32() / denom : u32() / u32());
    const baseHeadroom = unsigned();
    const alternateHeadroom = unsigned();
    const channels: GainMapChannel[] = [];
    for (let i = 0; i < count; i++) {
      channels.push({
        min: signed(),
        max: signed(),
        gamma: unsigned(),
        baseOffset: signed(),
        alternateOffset: signed(),
      });
    }
    if (channels.some((c) => !Object.values(c).every(Number.isFinite) || c.gamma <= 0)) return null;
    return { baseHeadroom, alternateHeadroom, channels, useBaseColourSpace: (flags & BASE_COLOUR_SPACE) !== 0 };
  } catch {
    return null; // too short
  }
}

/** The binary block, with a common denominator. */
export function encodeGainMapMetadata(meta: GainMapMetadata): Buffer {
  const values = meta.channels.flatMap((c) => [c.min, c.max, c.gamma, c.baseOffset, c.alternateOffset]);
  const out = Buffer.alloc(5 + 4 * 3 + 4 * values.length);
  let at = out.writeUInt16BE(0, 0);
  at = out.writeUInt16BE(0, at);
  const flags =
    (meta.channels.length === 3 ? MULTI_CHANNEL : 0) |
    (meta.useBaseColourSpace ? BASE_COLOUR_SPACE : 0) |
    COMMON_DENOMINATOR;
  at = out.writeUInt8(flags, at);
  at = out.writeUInt32BE(DENOMINATOR, at);
  at = out.writeUInt32BE(Math.round(meta.baseHeadroom * DENOMINATOR), at);
  at = out.writeUInt32BE(Math.round(meta.alternateHeadroom * DENOMINATOR), at);
  for (const c of meta.channels) {
    at = out.writeInt32BE(Math.round(c.min * DENOMINATOR), at);
    at = out.writeInt32BE(Math.round(c.max * DENOMINATOR), at);
    at = out.writeUInt32BE(Math.round(c.gamma * DENOMINATOR), at);
    at = out.writeInt32BE(Math.round(c.baseOffset * DENOMINATOR), at);
    at = out.writeInt32BE(Math.round(c.alternateOffset * DENOMINATOR), at);
  }
  return out;
}

/** The hdrgm XMP for the gain map image, for readers that predate ISO 21496-1. */
export function gainMapXmp(meta: GainMapMetadata): string {
  const each = (pick: (c: GainMapChannel) => number) => {
    const v = meta.channels.map(pick);
    return v.every((x) => x === v[0]) ? String(v[0]) : v.join(", ");
  };
  const attrs = [
    `hdrgm:Version="1.0"`,
    `hdrgm:BaseRenditionIsHDR="False"`,
    `hdrgm:GainMapMin="${each((c) => c.min)}"`,
    `hdrgm:GainMapMax="${each((c) => c.max)}"`,
    `hdrgm:Gamma="${each((c) => c.gamma)}"`,
    `hdrgm:OffsetSDR="${each((c) => c.baseOffset)}"`,
    `hdrgm:OffsetHDR="${each((c) => c.alternateOffset)}"`,
    `hdrgm:HDRCapacityMin="${meta.baseHeadroom}"`,
    `hdrgm:HDRCapacityMax="${meta.alternateHeadroom}"`,
  ];
  return (
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ${attrs.join(" ")}/>` +
    `</rdf:RDF></x:xmpmeta>`
  );
}
