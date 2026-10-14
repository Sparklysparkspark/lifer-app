// Recursive folder walk for the library reimport and trip scans. Async, one directory handle at a
// time, so a big tree on a slow network drive never blocks the event loop.
import { opendir } from "node:fs/promises";
import path from "node:path";

/** Every file under `root`, skipping dotfiles and dot-folders and any folder `skipDir` rejects.
 *  A missing root yields nothing. */
export async function* walkFiles(
  root: string,
  skipDir: (absolutePath: string) => boolean = () => false,
): AsyncGenerator<{ absolutePath: string; name: string }> {
  let dir;
  try {
    dir = await opendir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for await (const entry of dir) {
    if (entry.name.startsWith(".")) continue;
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(absolutePath)) yield* walkFiles(absolutePath, skipDir);
    } else {
      yield { absolutePath, name: entry.name };
    }
  }
}
