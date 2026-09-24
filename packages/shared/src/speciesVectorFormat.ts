// Binary format for a one-vector-per-species table (species_reference_embeddings,
// species_text_embeddings), published as its own compact asset the same way
// galleryEmbeddingsFormat.ts covers the per-gallery-photo table. species_id is already a
// portable natural key (species itself is in the catalog seed), so no id remapping is needed.
// Node-only; import as "@lifer/shared/src/speciesVectorFormat.js".
import { float16BitsToFloat32, float32ToFloat16Bits } from "./galleryEmbeddingsFormat.js";

export const SPECIES_VECTOR_MAGIC = "LSVE";
export const SPECIES_VECTOR_FORMAT_VERSION = 1;

export interface SpeciesVectorHeader {
  formatVersion: number;
  dimension: number;
  rowCount: number;
  modelVersion: string;
}

export interface SpeciesVectorRecord {
  speciesId: string;
  embedding: number[];
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

export function encodeSpeciesVectorHeader(header: Omit<SpeciesVectorHeader, "formatVersion">): Buffer {
  const mv = Buffer.from(header.modelVersion, "utf8");
  const buf = Buffer.alloc(4 + 2 + 2 + 4 + 2 + mv.length);
  buf.write(SPECIES_VECTOR_MAGIC, 0, "ascii");
  buf.writeUInt16LE(SPECIES_VECTOR_FORMAT_VERSION, 4);
  buf.writeUInt16LE(header.dimension, 6);
  buf.writeUInt32LE(header.rowCount, 8);
  buf.writeUInt16LE(mv.length, 12);
  mv.copy(buf, 14);
  return buf;
}

export function encodeSpeciesVectorRecord(record: SpeciesVectorRecord, dimension: number): Buffer {
  if (record.embedding.length !== dimension) {
    throw new Error(`Embedding for ${record.speciesId} has ${record.embedding.length} dims, expected ${dimension}`);
  }
  const buf = Buffer.alloc(16 + dimension * 2);
  uuidToBytes(record.speciesId).copy(buf, 0);
  let off = 16;
  for (const v of record.embedding) {
    buf.writeUInt16LE(float32ToFloat16Bits(v), off);
    off += 2;
  }
  return buf;
}

export async function* decodeSpeciesVectors(
  chunks: AsyncIterable<Buffer>,
  onHeader: (header: SpeciesVectorHeader) => void,
): AsyncGenerator<SpeciesVectorRecord> {
  let pending: Buffer = Buffer.alloc(0);
  let header: SpeciesVectorHeader | null = null;
  let seen = 0;

  for await (const chunk of chunks) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let pos = 0;

    if (!header) {
      if (pending.length < 14) continue;
      if (pending.toString("ascii", 0, 4) !== SPECIES_VECTOR_MAGIC) throw new Error("Not a Lifer species vector file");
      const formatVersion = pending.readUInt16LE(4);
      if (formatVersion !== SPECIES_VECTOR_FORMAT_VERSION) throw new Error(`Unsupported species vector format version ${formatVersion}`);
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

    const recLen = 16 + header.dimension * 2;
    while (pending.length - pos >= recLen) {
      const speciesId = bytesToUuid(pending, pos);
      const embedding = new Array<number>(header.dimension);
      let off = pos + 16;
      for (let i = 0; i < header.dimension; i++, off += 2) embedding[i] = float16BitsToFloat32(pending.readUInt16LE(off));
      yield { speciesId, embedding };
      seen++;
      pos += recLen;
    }
    pending = pos === 0 ? pending : pending.subarray(pos);
  }

  if (!header) throw new Error("Species vector file is empty or truncated");
  if (pending.length > 0) throw new Error("Species vector file ends mid-record (truncated download?)");
  if (seen !== header.rowCount) throw new Error(`Species vector file has ${seen} rows, header says ${header.rowCount}`);
}
