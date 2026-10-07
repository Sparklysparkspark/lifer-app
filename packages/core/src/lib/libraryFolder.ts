// Notices when the library folder (DATA_DIR) or app data folder (APP_DATA_DIR) goes away under
// a running Lifer, so saving fails with an explanation and the app can show a banner. In Docker a
// moved bind-mounted folder still stats as a directory (link count 0) but every create fails.
import { statSync } from "node:fs";
import { APP_DATA_DIR, DATA_DIR, SINGLE_USER_MODE } from "../config.js";
import { isWithinResolved } from "./pathContainment.js";
import { log } from "./log.js";

export type FolderProblem = "missing" | "moved";

export interface LibraryFolderStatus {
  ok: boolean;
  problems: Array<{ folder: "library" | "appData"; path: string; problem: FolderProblem; message: string }>;
}

function problemFor(dir: string): FolderProblem | null {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return "missing";
    // A directory that's been deleted, but is still held open by a mount, has no links left.
    return st.nlink === 0 ? "moved" : null;
  } catch {
    return "missing";
  }
}

function describe(folder: "library" | "appData", dir: string, problem: FolderProblem): string {
  const what = folder === "library" ? "photo library folder" : "app data folder";
  const happened =
    problem === "moved"
      ? `Lifer's ${what} (${dir}) was moved or deleted while Lifer was running, so nothing can be saved there.`
      : `Lifer's ${what} (${dir}) is missing, so nothing can be saved there.`;
  const fix = SINGLE_USER_MODE
    ? "Move it back, or choose its new location in Settings > Storage, then restart Lifer."
    : "Move it back to where it was, or update the folder in your Docker setup to its new location, then restart Lifer.";
  return `${happened} ${fix}`;
}

export function libraryFolderStatus(): LibraryFolderStatus {
  const problems: LibraryFolderStatus["problems"] = [];
  for (const [folder, dir] of [
    ["library", DATA_DIR],
    ["appData", APP_DATA_DIR],
  ] as const) {
    const problem = problemFor(dir);
    if (problem) problems.push({ folder, path: dir, problem, message: describe(folder, dir, problem) });
  }
  return { ok: problems.length === 0, problems };
}

export class LibraryFolderUnavailableError extends Error {
  statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = "LibraryFolderUnavailableError";
  }
}

/** When a write under `dir` failed, a readable reason if it's because the library or app data
 *  folder is gone, else null (so the caller reports the original error). */
export function explainMissingLibraryFolder(dir: string): LibraryFolderUnavailableError | null {
  const { problems } = libraryFolderStatus();
  const hit = problems.find((p) => isWithinResolved(p.path, dir));
  return hit ? new LibraryFolderUnavailableError(hit.message) : null;
}

let lastLogged = "";
/** Checks every minute and logs once when the folders go missing (and once when they're back),
 *  so the server log explains failed uploads without anyone having to open the app. */
export function watchLibraryFolder(): void {
  const check = () => {
    const status = libraryFolderStatus();
    const summary = status.problems.map((p) => p.message).join(" ");
    if (summary === lastLogged) return;
    if (summary) log.error(`[library] ${summary}`);
    else if (lastLogged) log.warn("[library] The library folders are available again.");
    lastLogged = summary;
  };
  check();
  setInterval(check, 60_000).unref();
}
