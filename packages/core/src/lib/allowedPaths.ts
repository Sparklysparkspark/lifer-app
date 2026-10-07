// The rule for any route that takes a filesystem path: on a server only DATA_DIR and
// LIFER_LIBRARY_ROOTS are allowed, checked lexically before touching the candidate on disk so a
// 403 never reveals whether a path exists. On desktop any path the user picks is allowed.
import { realpathSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, LIBRARY_ROOTS, SINGLE_USER_MODE } from "../config.js";
import { canonicalPath, isWithin } from "./pathContainment.js";

export { isWithin } from "./pathContainment.js";

export class PathNotAllowedError extends Error {
  statusCode = 403;
  constructor(
    message = "Lifer doesn't have access to that folder. Add it to LIFER_LIBRARY_ROOTS on the server to use it.",
  ) {
    super(message);
    this.name = "PathNotAllowedError";
  }
}

export interface AllowedRoot {
  label: string;
  path: string;
}

export function allowedRoots(): AllowedRoot[] {
  return [{ label: "Lifer library", path: path.resolve(DATA_DIR) }, ...LIBRARY_ROOTS];
}

/** The allowed root containing absPath (lexically), or null. absPath may be spelled through the
 *  root as configured or through its resolved form: assertAllowedPath hands back realpaths, and
 *  those come back in (a trip's default destination, the folder browser's entries). Only the root
 *  is resolved here, never absPath. The most specific root wins. */
export function allowedRootFor(absPath: string): AllowedRoot | null {
  const resolved = path.resolve(absPath);
  let best: AllowedRoot | null = null;
  let bestLength = -1;
  for (const root of allowedRoots()) {
    for (const form of new Set([root.path, canonicalPath(root.path)])) {
      if (isWithin(form, resolved) && form.length > bestLength) {
        best = root;
        bestLength = form.length;
      }
    }
  }
  return best;
}

/** Returns the path to use (realpath'd on a server) or throws PathNotAllowedError. Callers keep
 *  their own "is it absolute / does it exist" validation for the desktop case. */
export function assertAllowedPath(absPath: string): string {
  if (SINGLE_USER_MODE) return path.resolve(absPath);
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) throw new PathNotAllowedError();
  const root = allowedRootFor(absPath);
  if (!root) throw new PathNotAllowedError();
  // A symlink inside an allowed root must not lead outside it. Both sides realpath'd, so the
  // comparison is in one form whichever spelling matched above.
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root.path);
    real = realpathSync(path.resolve(absPath));
  } catch {
    throw new PathNotAllowedError("That folder doesn't exist or isn't readable by the server.");
  }
  if (!isWithin(realRoot, real)) throw new PathNotAllowedError();
  return real;
}
