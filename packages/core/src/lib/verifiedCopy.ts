// Copies one file so the copy is either complete and proven identical, or not there at all: the
// bytes are hashed as they are read once, written to a ".lifer-partial" beside the target, flushed
// to the drive, read back and compared, and only then given the target's name. A file already at
// the target is never replaced. The copy keeps the original's timestamps, since archive health
// reads a new modification time as an edit.
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { link, open, rename, rm, stat, unlink, utimes, type FileHandle } from "node:fs/promises";
import { DiskFullError, isDiskFull } from "./freeSpace.js";

export const PARTIAL_SUFFIX = ".lifer-partial";

/** sha256 hex of a file, streamed so a file of any size is never held in memory. */
export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  for (let done = 0; done < chunk.length;) done += (await handle.write(chunk, done)).bytesWritten;
}

/** Gives `partial` the name `to`, failing with EEXIST rather than replacing a file already there. */
async function placeNew(partial: string, to: string): Promise<void> {
  try {
    // link fails on a taken name, where rename would replace the file.
    await link(partial, to);
    await unlink(partial).catch(() => {});
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
  }
  // shortcut: a file created at `to` between this check and the rename is replaced; only another
  // process writing that exact name could, on a filesystem without hard links (exFAT).
  if (existsSync(to)) throw coded("Another file took that name", "EEXIST");
  await rename(partial, to);
}

/** Copies `from` to the new file `to` and returns its sha256. Throws (and leaves no file at `to`)
 *  when `to` exists, the source changed while it was read, the copy read back differently, or the
 *  drive filled up (a DiskFullError). `rehash` reads the finished copy back; tests replace it. */
export async function copyVerified(
  from: string,
  to: string,
  options: { rehash?: (file: string) => Promise<string> } = {},
): Promise<{ sha256: string; size: number }> {
  const { rehash = hashFile } = options;
  if (existsSync(to)) throw coded("A file with that name is already there", "EEXIST");
  const before = await stat(from);
  const partial = to + PARTIAL_SUFFIX;
  let handle: FileHandle | null = null;
  try {
    // Only a run cut short leaves one, since the name is Lifer's own: truncated and reused.
    handle = await open(partial, "w");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(from, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      bytes += chunk.length;
      await writeAll(handle, chunk);
    }
    const after = await stat(from);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw coded("The file changed while it was being copied", "source_changed");
    // Best effort, as copyFile does: some network and camera-card filesystems refuse modes.
    await handle.chmod(before.mode & 0o7777).catch(() => {});
    await handle.sync();
    await handle.close();
    handle = null;
    // After closing, since some network drives stamp the time when a written file closes.
    await utimes(partial, before.atime, before.mtime);
    const sha256 = hash.digest("hex");
    if ((await rehash(partial)) !== sha256)
      throw coded("The copy didn't match the original, so it was removed", "verify_failed");
    await placeNew(partial, to);
    return { sha256, size: bytes };
  } catch (err) {
    await handle?.close().catch(() => {});
    await rm(partial, { force: true }).catch(() => {});
    throw isDiskFull(err) ? new DiskFullError(0, 0, to) : err;
  }
}
