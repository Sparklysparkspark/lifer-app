// "Is this path inside that folder?" for every filesystem check in Lifer. Both sides must be in
// the same form: a realpath'd path never matches an unresolved root when the root sits behind a
// symlink (macOS's /tmp -> /private/tmp, a symlinked NAS mount). Compare with isWithinResolved,
// or canonicalPath both sides yourself before isWithin. No config import, so config.ts can use it.
import { realpathSync } from "node:fs";
import path from "node:path";

/** Lexical: candidate is root itself or inside it. Both must already be absolute and in the same
 *  form. path.relative rather than startsWith(root + sep), which breaks on a filesystem root and
 *  needs the separator to rule out a sibling like /data2 next to /data. */
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  // Stryker disable next-line ConditionalExpression,StringLiteral: equivalent, "" (the root itself) also passes the checks after ||
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

/** The real path of p with every symlink resolved. A path that doesn't exist yet (a folder about
 *  to be created, a file just deleted) resolves its deepest existing ancestor and keeps the rest,
 *  so it still compares equal to the resolved form of its root. */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return abs;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** candidate is root or inside it once both are resolved: a symlinked root still matches, and a
 *  symlink inside root that leads out of it doesn't. */
export function isWithinResolved(root: string, candidate: string): boolean {
  return isWithin(canonicalPath(root), canonicalPath(candidate));
}
