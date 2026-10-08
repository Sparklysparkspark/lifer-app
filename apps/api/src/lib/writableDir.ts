import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Whether Lifer can create files in `dir` (creating it if needed), or the error saying why not. */
export async function checkWritableDir(dir: string): Promise<NodeJS.ErrnoException | null> {
  const probe = path.join(dir, `.lifer-write-check-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true });
    return null;
  } catch (err) {
    return err as NodeJS.ErrnoException;
  }
}
