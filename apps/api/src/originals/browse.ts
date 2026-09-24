// Shows a file in the OS file manager. The API runs on the user's own machine in desktop
// mode, so it can shell out directly.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function revealFile(absolutePath: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", absolutePath]);
  } else if (process.platform === "win32") {
    // explorer.exe exits with code 1 even when it succeeds, so its exit status is ignored.
    await execFileAsync("explorer.exe", [`/select,${absolutePath}`]).catch(() => {});
  } else {
    // No portable "select this file" on Linux; open the containing folder instead.
    await execFileAsync("xdg-open", [path.dirname(absolutePath)]);
  }
}
