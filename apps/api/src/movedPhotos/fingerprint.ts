// A cheap, stable identity for a photo file: size, mtime, (dev, ino) and a quick hash of its ends.
// Used to find a file again after the user moves or renames it.
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, stat } from "node:fs/promises";

const EDGE = 64 * 1024;

export interface FileIdentity {
  size: number;
  mtime: Date;
  mtimeMs: number;
  /** "dev:ino", or null where the filesystem has no stable inode numbers. */
  fileId: string | null;
}

export function identityOf(s: BigIntStats): FileIdentity {
  // Rounded to the millisecond like a plain fs.stat's mtime, so it equals what archive health reads.
  const mtimeMs = Math.round(Number(s.mtimeNs / 1000n) / 1000);
  return {
    size: Number(s.size),
    mtime: new Date(mtimeMs),
    mtimeMs,
    // ino 0 means the filesystem doesn't give one (some network shares, FAT on Windows).
    fileId: s.ino > 0n ? `${s.dev}:${s.ino}` : null,
  };
}

export async function statIdentity(file: string): Promise<FileIdentity> {
  return identityOf(await stat(file, { bigint: true }));
}

/** sha1 of the size, the first 64 KB and the last 64 KB: two small reads, whatever the file size. */
export async function quickHash(file: string, size: number): Promise<string> {
  const hash = createHash("sha1").update(String(size));
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(Math.min(EDGE, size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > EDGE) {
      const tailStart = Math.max(EDGE, size - EDGE);
      const tail = Buffer.alloc(size - tailStart);
      await handle.read(tail, 0, tail.length, tailStart);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export interface Fingerprint extends FileIdentity {
  quickHash: string;
}

export async function fingerprintFile(file: string): Promise<Fingerprint> {
  const id = await statIdentity(file);
  return { ...id, quickHash: await quickHash(file, id.size) };
}
