// The one rule for any route that takes a filesystem path from a request: on a server, Lifer may
// only touch folders it was given, which is the main library (DATA_DIR) plus the admin-declared
// LIFER_LIBRARY_ROOTS. Anything else is refused with a 403, checked lexically BEFORE touching the
// filesystem so the response is never an oracle for "does this path exist". On desktop (a local
// single-user install) any path the user picks is allowed, unchanged from before.
import { realpathSync } from "node:fs";
import path from "node:path";
import { DATA_DIR, LIBRARY_ROOTS, SINGLE_USER_MODE } from "../config.js";

export class PathNotAllowedError extends Error {
  statusCode = 403;
  constructor(message = "Lifer doesn't have access to that folder. Add it to LIFER_LIBRARY_ROOTS on the server to use it.") {
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

// path.relative rather than startsWith(root + sep), which breaks on a filesystem root.
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** The allowed root containing absPath (lexically), or null. */
export function allowedRootFor(absPath: string): AllowedRoot | null {
  const resolved = path.resolve(absPath);
  let best: AllowedRoot | null = null;
  for (const root of allowedRoots()) {
    if (isWithin(root.path, resolved) && (!best || root.path.length > best.path.length)) best = root;
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
  // A symlink inside an allowed root must not lead outside it.
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
