// The one place the API writes, moves or deletes original photo files; eslint.config.mjs bans
// direct fs writes elsewhere. Every move copies with copyVerified across drives and deletes the
// source only once the copy is proven identical, and nothing here replaces an existing file.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { link, mkdir, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureRoom } from "@lifer/core/lib/freeSpace.js";
import { log } from "@lifer/core/lib/log.js";
import { copyVerified } from "@lifer/core/lib/verifiedCopy.js";
import { promisify } from "node:util";

export { copyVerified as copyOriginal } from "@lifer/core/lib/verifiedCopy.js";

function guard(...paths: string[]): void {
  for (const p of paths) if (!path.isAbsolute(p)) throw new Error(`Refusing to write a relative path: ${p}`);
}

/** Renames a file or folder. Never replaces a file; a folder only replaces an empty one, which
 *  rename itself enforces. */
export async function renameOriginal(from: string, to: string): Promise<void> {
  guard(from, to);
  if (existsSync(to) && !(await stat(to)).isDirectory()) throw Object.assign(new Error("exists"), { code: "EEXIST" });
  await rename(from, to);
}

/** Creates a new small file (a sidecar beside a linked photo). Never replaces one: EEXIST throws. */
export async function createSidecarFile(file: string, contents: string): Promise<void> {
  guard(file);
  await writeFile(file, contents, { flag: "wx" });
}

export async function removeOriginal(file: string): Promise<void> {
  guard(file);
  await rm(file, { force: true });
}

/** Removes a folder of originals and everything in it. */
export async function removeOriginalsFolder(dir: string): Promise<void> {
  guard(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Moves `from` to `to`: a rename on the same drive, else a verified copy. `commit` (saving the new
 *  path) runs while both exist; if it throws the move is undone. The source is deleted last, and a
 *  failed delete only leaves a spare copy, since the move is already recorded. */
export async function moveOriginal(from: string, to: string, commit?: () => Promise<void>): Promise<void> {
  guard(from, to);
  let copied = false;
  try {
    await renameOriginal(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
    await ensureRoom(to, (await stat(from)).size);
    await copyVerified(from, to);
    copied = true;
  }
  try {
    await commit?.();
  } catch (err) {
    if (copied) await rm(to, { force: true }).catch(() => {});
    else await rename(to, from).catch(() => {});
    throw err;
  }
  if (copied)
    await rm(from, { force: true }).catch((err: unknown) =>
      log.warn({ err, ref: from }, "Moved an original but couldn't delete its old copy"),
    );
}

/** A second copy of `from` at the new path `to`, leaving `from` alone: a hard link on the same
 *  drive, else a verified copy. */
export async function linkOrCopyOriginal(from: string, to: string): Promise<void> {
  guard(from, to);
  try {
    await link(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err;
    // Another drive, or a filesystem without hard links.
  }
  await ensureRoom(path.dirname(to), (await stat(from)).size);
  await copyVerified(from, to);
}

/** Copies the folder `from` into `to` (missing or empty), every file verified and keeping its
 *  timestamps. Symlinks are copied as links. */
export async function copyOriginalsFolder(from: string, to: string): Promise<void> {
  guard(from, to);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const [src, dest] = [path.join(from, entry.name), path.join(to, entry.name)];
    if (entry.isDirectory()) await copyOriginalsFolder(src, dest);
    else if (entry.isSymbolicLink()) await symlink(await readlink(src), dest);
    else if (entry.isFile()) await copyVerified(src, dest);
    // The caller deletes `from` after this, so nothing may be skipped silently.
    else throw new Error(`Can't copy ${src}: it isn't a file or folder`);
  }
}

const run = promisify(execFile);

/** Sends files to the system Trash (Recycle Bin on Windows), where the user can put them back.
 *  Throws unless every file is gone from where it was afterwards. */
export async function moveToSystemTrash(files: string[]): Promise<void> {
  guard(...files);
  if (files.length === 0) return;
  if (process.platform === "darwin") {
    // macOS 15 and later ship a trash command; older ones ask Finder.
    if (existsSync("/usr/bin/trash")) await run("/usr/bin/trash", ["--", ...files]);
    else
      await run("osascript", [
        "-e",
        "on run argv",
        "-e",
        'repeat with f in argv\ntell application "Finder" to delete (POSIX file (f as text))\nend repeat',
        "-e",
        "end run",
        ...files,
      ]);
  } else if (process.platform === "win32") {
    // Paths go through the environment, so no quoting of them can break the command.
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($f in $env:LIFER_TRASH -split \"`n\") { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
      ],
      { env: { ...process.env, LIFER_TRASH: files.join("\n") } },
    );
  } else {
    await run("gio", ["trash", "--", ...files]);
  }
  const left = files.filter((f) => existsSync(f));
  if (left.length > 0) throw new Error(`Couldn't move ${left.length} file(s) to the Trash`);
}
