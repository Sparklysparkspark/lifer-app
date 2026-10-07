// Extracts chosen files from a zip (a Python wheel, a NuGet package) one at a time, streaming each
// through inflate, so a 700 MB archive never sits in memory. Config-free.
import { createWriteStream, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

async function readEntries(file: string): Promise<Entry[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    // The end-of-central-directory record sits in the last 64 KB (its comment is at most 65535).
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await fh.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error(`${path.basename(file)} isn't a zip file`);
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64: the real values are in the zip64 end record a locator points at.
    if (cdOffset === 0xffffffff || count === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50)
        throw new Error(`${path.basename(file)}: zip64 locator missing`);
      const z64At = Number(tail.readBigUInt64LE(loc + 8));
      const z64 = Buffer.alloc(56);
      await fh.read(z64, 0, 56, z64At);
      count = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    const entries: Entry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error(`${path.basename(file)}: damaged central directory`);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let uncompressedSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localHeaderOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      // Zip64 extra field: 64-bit sizes and offset, in that order, for the fields that overflowed.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x);
        const len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) localHeaderOffset = Number(cd.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      entries.push({ name, method, compressedSize, localHeaderOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Writes each file whose zip path `pick` maps to a name into `destDir`. Returns what it wrote. */
export async function extractZipEntries(
  file: string,
  destDir: string,
  pick: (zipPath: string) => string | null,
): Promise<string[]> {
  const written: string[] = [];
  mkdirSync(destDir, { recursive: true });
  for (const entry of await readEntries(file)) {
    const target = entry.name.endsWith("/") ? null : pick(entry.name);
    if (!target) continue;
    const fh = await open(file, "r");
    try {
      const header = Buffer.alloc(30);
      await fh.read(header, 0, 30, entry.localHeaderOffset);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: damaged local header`);
      const dataStart = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const source = fh.createReadStream({
        start: dataStart,
        end: dataStart + entry.compressedSize - 1,
        autoClose: false,
      });
      const out = path.join(destDir, target);
      mkdirSync(path.dirname(out), { recursive: true });
      if (entry.method === 0) await pipeline(source, createWriteStream(out, { mode: 0o755 }));
      else if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(out, { mode: 0o755 }));
      else throw new Error(`${entry.name}: unsupported compression ${entry.method}`);
      written.push(out);
    } finally {
      await fh.close();
    }
  }
  return written;
}
