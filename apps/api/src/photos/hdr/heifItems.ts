// Just enough of an AVIF/HEIF file's 'meta' box to find its primary image's colour and an HDR gain
// map: the items, their properties and references, and where each item's bytes are.

export interface HeifItem {
  id: number;
  type: string;
  /** Byte offset of the infe flags' last byte (its hidden bit), so the item can be made visible. */
  flagsAt: number;
  props: Array<{ type: string; data: Buffer }>;
}

export interface HeifFile {
  primary: number;
  /** Byte offset and width (2 or 4) of the pitm item id, so another item can be made primary. */
  primaryAt: { offset: number; size: number };
  items: Map<number, HeifItem>;
  refs: Array<{ type: string; from: number; to: number[] }>;
  data(id: number): Buffer | null;
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(at + 8));
      body += 8;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) return;
    yield { type, start: at, body, end: at + size };
    at += size;
  }
}

const child = (buf: Buffer, box: Box, type: string, skip = 0) =>
  [...boxes(buf, box.body + skip, box.end)].find((b) => b.type === type);

/** The meta box's contents; null for a file that isn't HEIF or is damaged. */
export function readHeif(buf: Buffer): HeifFile | null {
  try {
    const meta = [...boxes(buf, 0, buf.length)].find((b) => b.type === "meta");
    if (!meta) return null;
    const pitm = child(buf, meta, "pitm", 4);
    const iinf = child(buf, meta, "iinf", 4);
    const iloc = child(buf, meta, "iloc", 4);
    const iprp = child(buf, meta, "iprp", 4);
    if (!pitm || !iinf || !iloc || !iprp) return null;

    const primaryAt = { offset: pitm.body + 4, size: buf[pitm.body] === 0 ? 2 : 4 };
    const primary = primaryAt.size === 2 ? buf.readUInt16BE(primaryAt.offset) : buf.readUInt32BE(primaryAt.offset);

    const items = new Map<number, HeifItem>();
    const countSize = buf[iinf.body] === 0 ? 2 : 4;
    for (const infe of boxes(buf, iinf.body + 4 + countSize, iinf.end)) {
      if (infe.type !== "infe" || buf[infe.body]! < 2) continue;
      const idSize = buf[infe.body] === 2 ? 2 : 4;
      const id = idSize === 2 ? buf.readUInt16BE(infe.body + 4) : buf.readUInt32BE(infe.body + 4);
      const type = buf.toString("latin1", infe.body + 4 + idSize + 2, infe.body + 4 + idSize + 6);
      items.set(id, { id, type, flagsAt: infe.body + 3, props: [] });
    }

    const ipco = child(buf, iprp, "ipco");
    const ipma = child(buf, iprp, "ipma");
    if (!ipco || !ipma) return null;
    const props = [...boxes(buf, ipco.body, ipco.end)].map((b) => ({
      type: b.type,
      data: buf.subarray(b.body, b.end),
    }));
    const version = buf[ipma.body]!;
    const wide = (buf[ipma.body + 3]! & 1) === 1;
    let at = ipma.body + 4;
    const entries = buf.readUInt32BE(at);
    at += 4;
    for (let i = 0; i < entries; i++) {
      const id = version < 1 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
      at += version < 1 ? 2 : 4;
      const n = buf[at++]!;
      for (let j = 0; j < n; j++) {
        const index = wide ? buf.readUInt16BE(at) & 0x7fff : buf[at]! & 0x7f;
        at += wide ? 2 : 1;
        const prop = props[index - 1];
        if (prop) items.get(id)?.props.push(prop);
      }
    }

    const refs: HeifFile["refs"] = [];
    const iref = child(buf, meta, "iref", 4);
    if (iref) {
      const idSize = buf[iref.body] === 0 ? 2 : 4;
      const read = (o: number) => (idSize === 2 ? buf.readUInt16BE(o) : buf.readUInt32BE(o));
      for (const ref of boxes(buf, iref.body + 4, iref.end)) {
        const from = read(ref.body);
        const count = buf.readUInt16BE(ref.body + idSize);
        const to = Array.from({ length: count }, (_, k) => read(ref.body + idSize + 2 + k * idSize));
        refs.push({ type: ref.type, from, to });
      }
    }

    const idat = child(buf, meta, "idat", 4);
    const locations = readIloc(buf, iloc);
    return {
      primary,
      primaryAt,
      items,
      refs,
      data(id) {
        const loc = locations.get(id);
        if (!loc) return null;
        const base = loc.method === 1 ? (idat ? idat.body : -1) : 0;
        if (base < 0 || loc.method > 1) return null;
        return Buffer.concat(loc.extents.map(([o, l]) => buf.subarray(base + loc.base + o, base + loc.base + o + l)));
      },
    };
  } catch {
    return null;
  }
}

function readIloc(buf: Buffer, iloc: Box) {
  const version = buf[iloc.body]!;
  let at = iloc.body + 4;
  const sizes = buf.readUInt16BE(at);
  at += 2;
  const [offsetSize, lengthSize, baseSize, indexSize] = [sizes >> 12, (sizes >> 8) & 15, (sizes >> 4) & 15, sizes & 15];
  const read = (n: number) => {
    const v = n === 0 ? 0 : n === 4 ? buf.readUInt32BE(at) : n === 8 ? Number(buf.readBigUInt64BE(at)) : NaN;
    at += n;
    return v;
  };
  const count = version < 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
  at += version < 2 ? 2 : 4;
  const out = new Map<number, { method: number; base: number; extents: Array<[number, number]> }>();
  for (let i = 0; i < count; i++) {
    const id = version < 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
    at += version < 2 ? 2 : 4;
    let method = 0;
    if (version >= 1) {
      method = buf.readUInt16BE(at) & 15;
      at += 2;
    }
    at += 2; // data_reference_index
    const base = read(baseSize);
    const extents: Array<[number, number]> = [];
    const n = buf.readUInt16BE(at);
    at += 2;
    for (let j = 0; j < n; j++) {
      if (version >= 1 && indexSize > 0) read(indexSize);
      extents.push([read(offsetSize), read(lengthSize)]);
    }
    out.set(id, { method, base, extents });
  }
  return out;
}

/** An item's nclx colour, as ITU-T H.273 codes; null when it states none or an ICC profile. */
export function nclx(item: HeifItem | undefined): { primaries: number; transfer: number } | null {
  const colr = item?.props.find((p) => p.type === "colr" && p.data.toString("latin1", 0, 4) === "nclx");
  return colr ? { primaries: colr.data.readUInt16BE(4), transfer: colr.data.readUInt16BE(6) } : null;
}

/** A copy of the file whose primary image is `id`, so a decoder that reads only the primary
 *  image (sharp's) decodes that item instead. Every other byte stays as it was. */
export function withPrimary(buf: Buffer, file: HeifFile, id: number): Buffer {
  const out = Buffer.from(buf);
  if (file.primaryAt.size === 2) out.writeUInt16BE(id, file.primaryAt.offset);
  else out.writeUInt32BE(id, file.primaryAt.offset);
  const item = file.items.get(id);
  if (item) out[item.flagsAt] = out[item.flagsAt]! & ~1; // not hidden
  return out;
}
