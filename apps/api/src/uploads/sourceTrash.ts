// Sends originals to the system Trash from the folders they were imported from: after their import
// (the Import page's "Move photos into my library") or because the library already holds the same
// bytes ("Clear out the ones already in Lifer"). Only files in a folder the user imported from on
// this computer, never one the library itself uses, and only once the library's copy is proven.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ORIGINALS_DIR } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import { hashFile } from "@lifer/core/lib/verifiedCopy.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { moveToSystemTrash } from "../lib/originalsWrite.js";
import { imageDataHash } from "./exif.js";
import { inSourceFolder } from "./knownFiles.js";

export type TrashBlock =
  "not_in_source_folder" | "in_library" | "unreadable" | "no_library_copy" | "partner_stays" | "trash_failed";

/** Why a source file must stay, or null when it may go to the Trash. */
export function trashBlock(f: {
  inSourceFolder: boolean;
  inLibrary: boolean;
  sourceHash: string | null;
  /** The library copy holding these bytes is there, readable and unchanged. */
  libraryCopyOk: boolean;
}): TrashBlock | null {
  if (!f.inSourceFolder) return "not_in_source_folder";
  if (f.inLibrary) return "in_library";
  if (!f.sourceHash) return "unreadable";
  if (!f.libraryCopyOk) return "no_library_copy";
  return null;
}

const isXmp = (name: string) => path.extname(name).toLowerCase() === ".xmp";
const stemOf = (name: string) => path.basename(name, path.extname(name)).toLowerCase();

/** Inside Lifer's library folder, a trip's folders, or a file the library points at. */
async function inLibrary(userId: string, file: string): Promise<boolean> {
  const resolved = canonicalPath(file);
  const res = await pool.query<{ folder: string | null }>(
    `SELECT destination_folder AS folder FROM trips WHERE user_id = $1
     UNION ALL SELECT source_folder FROM trips WHERE user_id = $1
     UNION ALL SELECT ref FROM originals WHERE user_id = $1 AND ref = $2`,
    [userId, file],
  );
  const roots = [DATA_DIR, ORIGINALS_DIR, ...res.rows.flatMap((r) => (r.folder ? [r.folder] : []))];
  return roots.some((r) => {
    const root = canonicalPath(r);
    return root === resolved || isWithin(root, resolved);
  });
}

/** An original in the library made from these bytes, there and readable, its image unchanged.
 *  Lifer writes keywords and ratings into a stored JPEG, so a copy whose bytes moved on from the
 *  import still counts when its image data matches the source's. */
async function libraryCopyOk(userId: string, sha256: string, source: string): Promise<boolean> {
  const res = await pool.query<{ ref: string; content_hash: string; verified_hash: string | null }>(
    `SELECT o.ref, o.content_hash, o.verified_hash
       FROM originals o JOIN captures c ON c.id = o.capture_id
      WHERE o.user_id = $1 AND o.content_hash = $2 AND o.ref <> $3 AND o.health IS NULL`,
    [userId, sha256, source],
  );
  let sourceImage: string | null | undefined;
  for (const r of res.rows) {
    const now = await hashFile(r.ref).catch(() => null);
    if (!now) continue;
    if (now === r.content_hash || now === r.verified_hash) return true;
    sourceImage ??= await imageDataHash(source).catch(() => null);
    if (sourceImage && sourceImage === (await imageDataHash(r.ref).catch(() => null))) return true;
  }
  return false;
}

export interface TrashOutcome {
  moved: boolean;
  /** Why it stayed, for the Import page to say in plain words. */
  reason?: TrashBlock;
  /** Every file sent to the Trash, sidecars included. */
  trashed: string[];
}

/** The files that would go with `members` (a photo, or a RAW and its JPG) to the Trash, XMP sidecars
 *  included, or why they all stay. `expect` is the sha256 the library received, when known. */
async function planGroup(
  userId: string,
  members: Array<{ path: string; expect?: string }>,
): Promise<TrashBlock | string[]> {
  for (const m of members) {
    if (!path.isAbsolute(m.path)) return "not_in_source_folder";
    const sourceHash = await hashFile(m.path).catch(() => null);
    const block = trashBlock({
      inSourceFolder: await inSourceFolder(userId, m.path),
      inLibrary: await inLibrary(userId, m.path),
      sourceHash: sourceHash && (!m.expect || m.expect === sourceHash) ? sourceHash : null,
      libraryCopyOk: !!sourceHash && (await libraryCopyOk(userId, sourceHash, m.path)),
    });
    if (block) return block;
  }
  // A same-named photo left behind (the RAW of a JPG, say) keeps the whole pair and its sidecar.
  const files = new Set(members.map((m) => m.path));
  const sidecars: string[] = [];
  for (const dir of new Set(members.map((m) => path.dirname(m.path)))) {
    const names = await readdir(dir).catch(() => [] as string[]);
    const stems = new Set(members.filter((m) => path.dirname(m.path) === dir).map((m) => stemOf(m.path)));
    const ownNames = new Set(members.map((m) => path.basename(m.path).toLowerCase()));
    for (const name of names) {
      const full = path.join(dir, name);
      if (files.has(full)) continue;
      if (isXmp(name)) {
        // IMG_1.xmp beside IMG_1.CR3, or IMG_1.CR3.xmp.
        if (stems.has(stemOf(name)) || ownNames.has(name.toLowerCase().slice(0, -4))) sidecars.push(full);
      } else if (stems.has(stemOf(name))) return "partner_stays";
    }
  }
  return [...files, ...sidecars];
}

/** Sends `members` to the Trash together, with their XMP sidecars, or none of them. */
export async function trashSourceGroup(
  userId: string,
  members: Array<{ path: string; expect?: string }>,
): Promise<TrashOutcome> {
  const stay = (b: TrashBlock): TrashOutcome => ({ moved: false, reason: b, trashed: [] });
  const plan = await planGroup(userId, members);
  if (!Array.isArray(plan)) return stay(plan);
  try {
    await moveToSystemTrash(plan);
  } catch {
    return stay("trash_failed");
  }
  return { moved: true, trashed: plan };
}

/** The files among `paths` the library already holds the same bytes of, grouped with their RAW or
 *  JPG partner, and (unless `dryRun`) sent to the Trash. */
export async function clearKnownSources(
  userId: string,
  paths: string[],
  dryRun: boolean,
): Promise<{ cleared: number; trashed: string[]; kept: Array<{ path: string; reason: TrashBlock }> }> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = path.join(path.dirname(p), stemOf(p));
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let cleared = 0;
  const trashed: string[] = [];
  const kept: Array<{ path: string; reason: TrashBlock }> = [];
  await mapWithConcurrency([...groups.values()], 4, async (members) => {
    const group = members.map((m) => ({ path: m }));
    const out: TrashOutcome = dryRun
      ? await planGroup(userId, group).then((plan) =>
          Array.isArray(plan) ? { moved: true, trashed: [] } : { moved: false, reason: plan, trashed: [] },
        )
      : await trashSourceGroup(userId, group);
    if (out.moved) {
      cleared += members.length;
      trashed.push(...out.trashed);
    } else for (const m of members) kept.push({ path: m, reason: out.reason! });
  });
  return { cleared, trashed, kept };
}
