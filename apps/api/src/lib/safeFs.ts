// Folder and file writes into the photo library, done so a misbehaving filesystem can only fail
// one request, never freeze the whole server.
//
// Why not mkdirSync(dir, { recursive: true }): Node's recursive mkdir retries in a loop inside
// native code. If the filesystem keeps answering "parent missing" for a parent that does exist
// (seen on a NAS mount), it spins forever at 100% CPU, and because it's synchronous native code
// the event loop, every other request, and even the debugger are stuck behind it. The walk below
// creates one level at a time, so it does at most one mkdir per path component and then gives up
// with an error naming the folder.
//
// Everything here is async, so a slow network share only delays the request that's writing.
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile, copyFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { explainMissingLibraryFolder } from "./libraryFolder.js";

// Far more than any real folder of same-named photos; only a filesystem claiming every name
// exists would reach it.
const MAX_NAME_ATTEMPTS = 10_000;

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === code;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Creates `dir` and any missing parents, one level at a time. Throws a readable error naming
 *  the folder instead of retrying when the filesystem gives an answer that doesn't add up. */
export async function ensureDir(dir: string): Promise<void> {
  const target = path.resolve(dir);
  if (await isDirectory(target)) return;

  // Nearest existing ancestor first, then create downward from it.
  const missing: string[] = [];
  let current = target;
  while (!(await isDirectory(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Couldn't create folder ${target}: no part of that path exists`);
    current = parent;
  }
  for (const folder of missing.reverse()) {
    try {
      await mkdir(folder);
    } catch (err) {
      if (isCode(err, "EEXIST") && (await isDirectory(folder))) continue;
      // Parent "exists" but can't be written into: most likely the library folder was moved
      // away while Lifer runs. Say that, instead of a bare ENOENT.
      if (isCode(err, "ENOENT")) {
        const explained = explainMissingLibraryFolder(folder);
        if (explained) throw explained;
      }
      const reason = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
      throw new Error(`Couldn't create folder ${folder} (${reason})`);
    }
  }
  if (!(await isDirectory(target))) throw new Error(`Couldn't create folder ${target}: it still doesn't exist after creating it`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function candidateName(filename: string, attempt: number): string {
  if (attempt === 1) return filename;
  const ext = path.extname(filename);
  const base = ext ? filename.slice(0, -ext.length) : filename;
  return `${base}-${attempt}${ext}`;
}

/** A path in `dir` that doesn't exist yet: `filename`, else "-2", "-3"... Avoids silently
 *  overwriting a same-named file (two cameras both producing "IMG_0001.jpg") rather than
 *  guessing they're the same photo. */
export async function uniqueDestination(dir: string, filename: string): Promise<string> {
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = path.join(dir, candidateName(filename, attempt));
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Couldn't find a free file name for ${filename} in ${dir}`);
}

/** Writes `bytes` to a new file in `dir` (creating the folder), never overwriting an existing
 *  file, and returns the path used. Creation is exclusive, so two uploads of "IMG_0001.jpg"
 *  landing at the same moment get "IMG_0001.jpg" and "IMG_0001-2.jpg" instead of one
 *  overwriting the other. */
export async function writeNewFile(dir: string, filename: string, bytes: Buffer): Promise<string> {
  await ensureDir(dir);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = path.join(dir, candidateName(filename, attempt));
    try {
      await writeFile(candidate, bytes, { flag: "wx" });
      return candidate;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
    }
  }
  throw new Error(`Couldn't find a free file name for ${filename} in ${dir}`);
}

/** Copies `source` to a new file in `dir` (creating the folder), never overwriting, and returns
 *  the path used. For files too large to hold in memory, like videos. */
export async function copyToNewFile(dir: string, filename: string, source: string): Promise<string> {
  await ensureDir(dir);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = path.join(dir, candidateName(filename, attempt));
    try {
      await copyFile(source, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
    }
  }
  throw new Error(`Couldn't find a free file name for ${filename} in ${dir}`);
}

/** Moves `source` into `dir` under a free name and returns the new path. Renames when it can,
 *  and copies then deletes when the destination is on another drive. */
export async function moveToFolder(source: string, dir: string, filename = path.basename(source)): Promise<string> {
  await ensureDir(dir);
  const dest = await uniqueDestination(dir, filename);
  try {
    await rename(source, dest);
  } catch {
    await copyFile(source, dest, constants.COPYFILE_EXCL);
    await rm(source, { force: true });
  }
  return dest;
}
