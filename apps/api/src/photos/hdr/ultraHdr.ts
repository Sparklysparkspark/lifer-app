// Writes an Ultra HDR JPEG: an SDR JPEG with a gain map JPEG after it, found through an MPF index,
// described by ISO 21496-1 metadata and by the older hdrgm XMP. A reader without HDR shows the
// first JPEG as is.
import { encodeGainMapMetadata, gainMapXmp, type GainMapMetadata } from "./gainMapMetadata.js";

const ISO_URN = Buffer.from("urn:iso:std:iso:ts:21496:-1\0", "latin1");
const XMP_NS = Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1");
const ICC_TAG = Buffer.from("ICC_PROFILE\0", "latin1");

function segment(marker: number, payload: Buffer): Buffer {
  if (payload.length > 65533) throw new Error("JPEG segment too long");
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** The JPEG after its SOI and any APPn segments, so ours can go first. */
function body(jpeg: Buffer): Buffer {
  if (jpeg.readUInt16BE(0) !== 0xffd8) throw new Error("Not a JPEG");
  let at = 2;
  while (jpeg[at] === 0xff && jpeg[at + 1]! >= 0xe0 && jpeg[at + 1]! <= 0xef) at += 2 + jpeg.readUInt16BE(at + 2);
  return jpeg.subarray(at);
}

const SOI = Buffer.from([0xff, 0xd8]);

// MPF (CIPA DC-007): two entries, the primary and the gain map. Offsets count from the byte after
// "MPF\0" in the primary's APP2.
function mpf(primarySize: number, gainMapSize: number, gainMapOffset: number): Buffer {
  const out = Buffer.alloc(4 + 8 + 2 + 3 * 12 + 4 + 32);
  out.write("MPF\0", 0, "latin1");
  const t = 4;
  out.write("MM\0*", t, "latin1");
  out.writeUInt32BE(8, t + 4);
  let at = t + 8;
  at = out.writeUInt16BE(3, at);
  const entry = (tag: number, type: number, count: number, value: Buffer | number) => {
    at = out.writeUInt16BE(tag, at);
    at = out.writeUInt16BE(type, at);
    at = out.writeUInt32BE(count, at);
    if (typeof value === "number") at = out.writeUInt32BE(value, at);
    else at += value.copy(out, at);
  };
  entry(0xb000, 7, 4, Buffer.from("0100", "latin1"));
  entry(0xb001, 4, 1, 2);
  entry(0xb002, 7, 32, 8 + 2 + 3 * 12 + 4);
  at = out.writeUInt32BE(0, at);
  // Primary: JPEG, baseline MP primary image.
  at = out.writeUInt32BE(0x030000, at);
  at = out.writeUInt32BE(primarySize, at);
  at = out.writeUInt32BE(0, at);
  at = out.writeUInt32BE(0, at);
  at = out.writeUInt32BE(0, at);
  at = out.writeUInt32BE(gainMapSize, at);
  at = out.writeUInt32BE(gainMapOffset, at);
  out.writeUInt32BE(0, at);
  return out;
}

function containerXmp(gainMapSize: number): Buffer {
  return Buffer.from(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/" ` +
      `xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ` +
      `xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0">` +
      `<Container:Directory><rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainMapSize}"/></rdf:li>` +
      `</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
}

/** Joins a base JPEG and a gain map JPEG (both plain, from sharp) into one Ultra HDR JPEG. `icc`
 *  tags the base, written as is (no conversion), for a base that isn't sRGB. */
export function writeUltraHdr(base: Buffer, gainMap: Buffer, meta: GainMapMetadata, icc?: Buffer): Buffer {
  const gain = Buffer.concat([
    SOI,
    segment(0xe1, Buffer.concat([XMP_NS, Buffer.from(gainMapXmp(meta))])),
    segment(0xe2, Buffer.concat([ISO_URN, encodeGainMapMetadata(meta)])),
    body(gainMap),
  ]);
  const head = [
    SOI,
    segment(0xe1, Buffer.concat([XMP_NS, containerXmp(gain.length)])),
    segment(0xe2, Buffer.concat([ISO_URN, Buffer.alloc(4)])),
  ];
  if (icc) {
    if (icc.length > 65519) throw new Error("ICC profile too long");
    head.push(segment(0xe2, Buffer.concat([ICC_TAG, Buffer.from([1, 1]), icc])));
  }
  const before = Buffer.concat(head);
  const rest = body(base);
  const mpfLength = 4 + mpf(0, 0, 0).length;
  // The MPF segment's own offset is fixed by `before`; the gain map follows the whole primary.
  const primarySize = before.length + mpfLength + rest.length;
  const mpfStart = before.length + 4 + 4;
  const index = segment(0xe2, mpf(primarySize, gain.length, primarySize - mpfStart));
  return Buffer.concat([before, index, rest, gain]);
}
