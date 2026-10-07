// Photos checked on the import screen are kept for a while so importing doesn't resend them.
// Filed by user and sha256, rechecked before use, and removed once imported or after
// STAGE_MAX_AGE_MS.
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { uploadStagingDir, uploadTempDir } from "./uploadWorkDir.js";

export const STAGE_MAX_AGE_MS = 2 * 60 * 60_000;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const USER_ID = /^[0-9a-f-]{36}$/i;

function stagedPath(userId: string, fingerprint: string): string | null {
  if (!USER_ID.test(userId) || !FINGERPRINT.test(fingerprint)) return null;
  return path.join(uploadStagingDir(), userId, fingerprint);
}

/** sha256 hex of a file, streamed so a file of any size is never held in memory. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), async function (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) hash.update(chunk);
  });
  return hash.digest("hex");
}

/** Renames `source` to `dest`, copying then deleting when they are on different drives. Never
 *  overwrites an existing `dest` when it has to copy. */
export async function moveFile(source: string, dest: string): Promise<void> {
  try {
    await rename(source, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyFile(source, dest, constants.COPYFILE_EXCL);
    await rm(source, { force: true });
  }
}

/** Moves a just-inspected temp file into the staging area. Best-effort: on failure the import
 *  simply sends the file again. */
export async function stageUpload(userId: string, fingerprint: string, tmpPath: string): Promise<boolean> {
  const target = stagedPath(userId, fingerprint);
  if (!target) return false;
  try {
    await ensureDir(path.dirname(target));
    await rm(target, { force: true });
    await moveFile(tmpPath, target);
    return true;
  } catch {
    return false;
  }
}

/** Streams an upload straight to disk, fingerprinting it on the way, so no upload is ever held in
 *  memory. Throws a 413 when the upload went over the size limit. */
export async function receiveToFile(
  file: NodeJS.ReadableStream & { truncated?: boolean },
  dest: string,
): Promise<{ fingerprint: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(file, hasher, createWriteStream(dest));
  if (file.truncated) {
    await rm(dest, { force: true });
    throw Object.assign(new Error("That file is larger than this server accepts"), { statusCode: 413 });
  }
  return { fingerprint: hash.digest("hex"), bytes };
}

/** Moves a kept file to `dest` for an import, then checks it still hashes to its fingerprint.
 *  False when there's no kept copy or it changed. */
export async function claimStagedUpload(userId: string, fingerprint: string, dest: string): Promise<boolean> {
  const target = stagedPath(userId, fingerprint);
  if (!target) return false;
  try {
    await moveFile(target, dest);
  } catch {
    return false;
  }
  try {
    if ((await hashFile(dest)) === fingerprint) return true;
  } catch {
    // unreadable: treated like a changed file
  }
  await rm(dest, { force: true });
  return false;
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 10 * 60_000;
// Scratch files a crashed request left behind; nothing legitimately runs this long.
const TEMP_MAX_AGE_MS = 6 * 60 * 60_000;

async function removeOlderThan(dir: string, maxAgeMs: number, now: number, depth: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = await stat(p);
      if (st.isDirectory()) {
        if (depth > 0) await removeOlderThan(p, maxAgeMs, now, depth - 1);
      } else if (now - st.mtimeMs > maxAgeMs) await rm(p, { force: true });
    } catch {
      // already gone
    }
  }
}

/** Deletes kept files nobody imported and stale scratch files. Called on each inspect and by the
 *  maintenance timer, but only looks every 10 minutes unless `force`. */
export async function sweepStagedUploads(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await removeOlderThan(uploadStagingDir(), STAGE_MAX_AGE_MS, now, 1);
  await removeOlderThan(uploadTempDir(), TEMP_MAX_AGE_MS, now, 0);
}
