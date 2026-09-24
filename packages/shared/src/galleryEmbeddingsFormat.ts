// Binary format for the per-gallery-photo CLIP vectors (species_reference_gallery_embeddings),
// published next to the catalog seed as lifer-gallery-embeddings-<modelVersion>.bin.gz. As
// pg_dump text these were over 1GB and made up almost all of the seed; float16 binary is about
// 1.5KB per row. Node-only (uses Buffer), so deliberately NOT exported from index.ts, which the
// web app also imports. Import it as "@lifer/shared/src/galleryEmbeddingsFormat.js".
//
// Layout (all integers little-endian):
//   header: "LGEM" | u16 formatVersion | u16 dimension | u32 rowCount | u16 len | modelVersion utf8
//   record: 16-byte species_id uuid | u16 len | photo_url utf8 | dimension x float16
// photo_url + species_id is the table's portable natural key (migration 003's UNIQUE constraint),
// so installs map rows onto their own species_reference_photos ids without any id remapping.

export const GALLERY_EMBEDDINGS_MAGIC = "LGEM";
export const GALLERY_EMBEDDINGS_FORMAT_VERSION = 1;

export interface GalleryEmbeddingsHeader {
  formatVersion: number;
  dimension: number;
  rowCount: number;
  modelVersion: string;
}

export interface GalleryEmbeddingRecord {
  speciesId: string;
  photoUrl: string;
  embedding: number[];
}

// IEEE 754 half-precision conversion. Node 22 has no Float16Array. Vectors are L2-normalized
// (components well inside float16 range), and float16's ~1e-3 relative error moves a cosine
// score by about 1e-4, far below the 0.025 suggestion confidence margin.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function float32ToFloat16Bits(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0); // Inf / NaN
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00; // overflow to Inf
  if (e <= 0) {
    if (e < -10) return sign; // underflow to zero
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    if ((mant >>> (shift - 1)) & 1) half += 1; // round half up
    return sign | half;
  }
  let half = sign | (e << 10) | (mant >>> 13);
  if (mant & 0x1000) half += 1; // round to nearest, carry may bump the exponent (still correct)
  return half;
}

export function float16BitsToFloat32(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Invalid uuid: ${uuid}`);
  return Buffer.from(hex, "hex");
}

function bytesToUuid(buf: Buffer, offset: number): string {
  const hex = buf.toString("hex", offset, offset + 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeGalleryEmbeddingsHeader(header: Omit<GalleryEmbeddingsHeader, "formatVersion">): Buffer {
  const mv = Buffer.from(header.modelVersion, "utf8");
  const buf = Buffer.alloc(4 + 2 + 2 + 4 + 2 + mv.length);
  buf.write(GALLERY_EMBEDDINGS_MAGIC, 0, "ascii");
  buf.writeUInt16LE(GALLERY_EMBEDDINGS_FORMAT_VERSION, 4);
  buf.writeUInt16LE(header.dimension, 6);
  buf.writeUInt32LE(header.rowCount, 8);
  buf.writeUInt16LE(mv.length, 12);
  mv.copy(buf, 14);
  return buf;
}

export function encodeGalleryEmbeddingRecord(record: GalleryEmbeddingRecord, dimension: number): Buffer {
  if (record.embedding.length !== dimension) {
    throw new Error(`Embedding for ${record.photoUrl} has ${record.embedding.length} dims, expected ${dimension}`);
  }
  const url = Buffer.from(record.photoUrl, "utf8");
  if (url.length > 0xffff) throw new Error(`photo_url too long: ${record.photoUrl.slice(0, 80)}`);
  const buf = Buffer.alloc(16 + 2 + url.length + dimension * 2);
  uuidToBytes(record.speciesId).copy(buf, 0);
  buf.writeUInt16LE(url.length, 16);
  url.copy(buf, 18);
  let off = 18 + url.length;
  for (const v of record.embedding) {
    buf.writeUInt16LE(float32ToFloat16Bits(v), off);
    off += 2;
  }
  return buf;
}

// Streaming decoder: feed it decompressed chunks, get header then records. Holds at most one
// partial record in memory, so the file size doesn't matter.
export async function* decodeGalleryEmbeddings(
  chunks: AsyncIterable<Buffer>,
  onHeader: (header: GalleryEmbeddingsHeader) => void,
): AsyncGenerator<GalleryEmbeddingRecord> {
  let pending: Buffer = Buffer.alloc(0);
  let header: GalleryEmbeddingsHeader | null = null;
  let seen = 0;

  for await (const chunk of chunks) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let pos = 0;

    if (!header) {
      if (pending.length < 14) continue;
      if (pending.toString("ascii", 0, 4) !== GALLERY_EMBEDDINGS_MAGIC) throw new Error("Not a Lifer gallery embeddings file");
      const formatVersion = pending.readUInt16LE(4);
      if (formatVersion !== GALLERY_EMBEDDINGS_FORMAT_VERSION) {
        throw new Error(`Unsupported gallery embeddings format version ${formatVersion}`);
      }
      const mvLen = pending.readUInt16LE(12);
      if (pending.length < 14 + mvLen) continue;
      header = {
        formatVersion,
        dimension: pending.readUInt16LE(6),
        rowCount: pending.readUInt32LE(8),
        modelVersion: pending.toString("utf8", 14, 14 + mvLen),
      };
      onHeader(header);
      pos = 14 + mvLen;
    }

    const vecBytes = header.dimension * 2;
    while (pending.length - pos >= 18) {
      const urlLen = pending.readUInt16LE(pos + 16);
      const recLen = 18 + urlLen + vecBytes;
      if (pending.length - pos < recLen) break;
      const speciesId = bytesToUuid(pending, pos);
      const photoUrl = pending.toString("utf8", pos + 18, pos + 18 + urlLen);
      const embedding = new Array<number>(header.dimension);
      let off = pos + 18 + urlLen;
      for (let i = 0; i < header.dimension; i++, off += 2) embedding[i] = float16BitsToFloat32(pending.readUInt16LE(off));
      yield { speciesId, photoUrl, embedding };
      seen++;
      pos += recLen;
    }
    pending = pos === 0 ? pending : pending.subarray(pos);
  }

  if (!header) throw new Error("Gallery embeddings file is empty or truncated");
  if (pending.length > 0) throw new Error("Gallery embeddings file ends mid-record (truncated download?)");
  if (seen !== header.rowCount) throw new Error(`Gallery embeddings file has ${seen} rows, header says ${header.rowCount}`);
}
