// macOS-only, deliberately: apps/api runs directly on the host Mac rather than in a
// container specifically so the API process itself can shell out to Finder directly.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function revealFile(absolutePath: string): Promise<void> {
  await execFileAsync("open", ["-R", absolutePath]);
}
