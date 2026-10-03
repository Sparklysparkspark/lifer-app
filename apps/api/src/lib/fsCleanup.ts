import { readdir, rm } from "node:fs/promises";
import path from "node:path";

// OS litter (Finder view metadata, Windows thumbnail caches) that doesn't count as real content
// when deciding whether a folder is empty.
const IGNORABLE_JUNK_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

// Deletes startDir and each parent in turn while it holds nothing but ignorable junk. Stops at the
// first folder with real content, and never removes stopAt itself or anything outside it.
export async function removeEmptyDirsUpward(startDir: string, stopAt: string): Promise<void> {
  let dir = startDir;
  while (dir !== stopAt && dir.startsWith(stopAt + path.sep)) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (entries.some((name) => !IGNORABLE_JUNK_FILES.has(name))) return;
    for (const name of entries) await rm(path.join(dir, name), { force: true });
    // recursive is needed to remove a directory at all; only ignorable junk was in it.
    await rm(dir, { recursive: true, force: true });
    dir = path.dirname(dir);
  }
}
