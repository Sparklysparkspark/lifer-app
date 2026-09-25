// Photos checked on the import screen (/uploads/inspect) are kept for a while, so importing them
// right after doesn't send every file over the network a second time. That second copy doubled
// the transfer for a batch: 6 to 25 MB per photo, which over Wi-Fi or a remote connection took
// longer than the server's own work on it.
//
// A kept file is filed by user and content hash (the same sha256 the upload stores as its
// fingerprint), so one user can never import another's, and the import re-checks the hash before
// using it. Kept files are removed once imported, or after STAGE_MAX_AGE_MS if never imported.
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { APP_DATA_DIR } from "../config.js";
import { ensureDir } from "./safeFs.js";

const STAGE_DIR = path.join(APP_DATA_DIR, "staging");
const STAGE_MAX_AGE_MS = 2 * 60 * 60_000;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const USER_ID = /^[0-9a-f-]{36}$/i;

function stagedPath(userId: string, fingerprint: string): string | null {
  if (!USER_ID.test(userId) || !FINGERPRINT.test(fingerprint)) return null;
  return path.join(STAGE_DIR, userId, fingerprint);
}

/** Moves a just-inspected temp file into the staging area. Best-effort: on failure the import
 *  simply sends the file again. */
export async function stageUpload(userId: string, fingerprint: string, tmpPath: string): Promise<boolean> {
  const target = stagedPath(userId, fingerprint);
  if (!target) return false;
  try {
    await ensureDir(path.dirname(target));
    await rename(tmpPath, target);
    return true;
  } catch {
    return false;
  }
}

/** The kept bytes for this fingerprint, or null when there are none (expired, never kept, or
 *  the server restarted onto a different app data folder). */
export async function readStagedUpload(userId: string, fingerprint: string): Promise<Buffer | null> {
  const target = stagedPath(userId, fingerprint);
  if (!target) return null;
  try {
    const bytes = await readFile(target);
    if (createHash("sha256").update(bytes).digest("hex") !== fingerprint) return null;
    return bytes;
  } catch {
    return null;
  }
}

/** Streams an upload straight to disk, fingerprinting it on the way, so a video is never held in
 *  memory (a 1.4 GB clip used to take 1.4 GB of server memory while it was checked, and again
 *  while it was imported). Throws when the upload went over the size limit. */
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

/** Moves a kept file to `dest` for an import to use (without reading it, so it works for a video
 *  of any size). False when there's no kept copy. */
export async function claimStagedUpload(userId: string, fingerprint: string, dest: string): Promise<boolean> {
  const target = stagedPath(userId, fingerprint);
  if (!target) return false;
  try {
    await rename(target, dest);
    return true;
  } catch {
    return false;
  }
}

export async function removeStagedUpload(userId: string, fingerprint: string): Promise<void> {
  const target = stagedPath(userId, fingerprint);
  if (target) await rm(target, { force: true }).catch(() => {});
}

let lastSweep = 0;
const SWEEP_EVERY_MS = 10 * 60_000;

/** Deletes kept files nobody imported. Called on each inspect, but only looks every 10 minutes. */
export async function sweepStagedUploads(now = Date.now()): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  let users: string[];
  try {
    users = await readdir(STAGE_DIR);
  } catch {
    return;
  }
  for (const user of users) {
    const dir = path.join(STAGE_DIR, user);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        if (now - (await stat(p)).mtimeMs > STAGE_MAX_AGE_MS) await rm(p, { force: true });
      } catch {
        // already gone
      }
    }
  }
}
