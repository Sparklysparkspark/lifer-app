// Sends originals to the system Trash from the folders they were imported from: after their import
// (the Import page's "Move photos into my library") or because the library already holds the same
// bytes ("Clear out the ones already in Lifer"). Only files in a folder the user imported from on
// this computer or picked in its Choose files dialog (pickedFiles.ts), never one the library
// itself uses, and only once the library's copy is proven.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, ORIGINALS_DIR } from "@lifer/core/config.js";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import { hashFile } from "@lifer/core/lib/verifiedCopy.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { moveToSystemTrash } from "../lib/originalsWrite.js";
import { imageDataHash } from "./exif.js";
import { inSourceFolder, isImportableName } from "./knownFiles.js";
import { wasPicked } from "./pickedFiles.js";

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

/** What goes with `members` (files in `dir`) from that folder's listing `names`: their XMP
 *  sidecars, under any of the names other apps give them (IMG_1.xmp, IMG_1.CR3.xmp, IMG_1.jpg.xmp,
 *  in any case, as a case-insensitive drive may list them). "partner_stays" when a photo or video
 *  of the same name isn't among them, since its sidecar may be theirs too. */
export function sidecarsIn(dir: string, names: string[], members: string[]): string[] | "partner_stays" {
  const own = new Set(members.map((m) => path.basename(m).toLowerCase()));
  const stems = new Set(members.map(stemOf));
  const listed = new Set(names.map((n) => n.toLowerCase()));
  const sidecars: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (own.has(lower)) continue;
    if (isXmp(name)) {
      const target = lower.slice(0, -".xmp".length);
      // IMG_1.CR3.xmp names its file; IMG_1.xmp is the stem's unless a file is named exactly that.
      if (own.has(target) || (stems.has(stemOf(name)) && !listed.has(target))) sidecars.push(path.join(dir, name));
    } else if (stems.has(stemOf(name)) && isImportableName(name)) return "partner_stays";
  }
  return sidecars;
}

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
 *  A hidden photo counts (a linked version is hidden under its group); one in Lifer's trash doesn't.
 *  Lifer writes keywords and ratings into a stored JPEG, so a copy whose bytes moved on from the
 *  import still counts when its image data matches the source's. Never verified_hash alone: the
 *  health check re-baselines it after any change with a new mtime (an edit, or damage), which
 *  says nothing about the library still holding this photo. */
async function libraryCopyOk(userId: string, sha256: string, source: string): Promise<boolean> {
  const res = await pool.query<{ ref: string; content_hash: string }>(
    `SELECT o.ref, o.content_hash
       FROM originals o JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
      WHERE o.user_id = $1 AND o.content_hash = $2 AND o.ref <> $3 AND o.health IS NULL`,
    [userId, sha256, source],
  );
  let sourceImage: string | null | undefined;
  // Why each copy didn't count, logged so a kept original can be explained.
  const misses: Array<{ ref: string; why: string }> = [];
  for (const r of res.rows) {
    const now = await hashFile(r.ref).catch(() => null);
    if (!now) {
      misses.push({ ref: r.ref, why: "unreadable" });
      continue;
    }
    if (now === r.content_hash) return true;
    sourceImage ??= await imageDataHash(source).catch(() => null);
    const copyImage = await imageDataHash(r.ref).catch(() => null);
    if (sourceImage && sourceImage === copyImage) return true;
    misses.push({ ref: r.ref, why: !sourceImage || !copyImage ? "no image hash" : "image differs" });
  }
  log.warn({ source, copies: res.rows.length, misses }, "Couldn't confirm the library copy of an original");
  return false;
}

export interface TrashOutcome {
  moved: boolean;
  /** Why it stayed, for the Import page to say in plain words. */
  reason?: TrashBlock;
  /** Every file sent to the Trash, sidecars included. */
  trashed: string[];
  /** How many of them were XMP sidecars. */
  sidecars: number;
}

interface Plan {
  files: string[];
  sidecars: string[];
}

/** The files that would go with `members` (a photo, or a RAW and its JPG) to the Trash, XMP sidecars
 *  included, or why they all stay. `expect` is the sha256 the library received, when known. */
async function planGroup(
  userId: string,
  members: Array<{ path: string; expect?: string }>,
): Promise<TrashBlock | Plan> {
  for (const m of members) {
    if (!path.isAbsolute(m.path)) return "not_in_source_folder";
    const sourceHash = await hashFile(m.path).catch(() => null);
    const block = trashBlock({
      inSourceFolder: wasPicked(m.path) || (await inSourceFolder(userId, m.path)),
      inLibrary: await inLibrary(userId, m.path),
      sourceHash: sourceHash && (!m.expect || m.expect === sourceHash) ? sourceHash : null,
      libraryCopyOk: !!sourceHash && (await libraryCopyOk(userId, sourceHash, m.path)),
    });
    if (block) return block;
  }
  const files = [...new Set(members.map((m) => m.path))];
  const sidecars: string[] = [];
  for (const dir of new Set(files.map((f) => path.dirname(f)))) {
    // A folder that can't be listed (a share that dropped) can't show what else is there.
    const names = await readdir(dir).catch(() => null);
    if (!names) return "unreadable";
    const found = sidecarsIn(
      dir,
      names,
      files.filter((f) => path.dirname(f) === dir),
    );
    if (found === "partner_stays") return found;
    sidecars.push(...found);
  }
  return { files, sidecars };
}

const gone = (files: string[]) => files.filter((f) => !existsSync(f));

/** Sends `members` to the Trash together, then their XMP sidecars, or none of them. A sidecar the
 *  Trash refuses stays where it was; it never goes before its photo. */
export async function trashSourceGroup(
  userId: string,
  members: Array<{ path: string; expect?: string }>,
): Promise<TrashOutcome> {
  const plan = await planGroup(userId, members);
  if (typeof plan === "string") return { moved: false, reason: plan, trashed: [], sidecars: 0 };
  try {
    await moveToSystemTrash(plan.files);
  } catch (err) {
    log.warn({ err, files: plan.files }, "Couldn't move originals to the Trash");
    return { moved: false, reason: "trash_failed", trashed: gone(plan.files), sidecars: 0 };
  }
  await moveToSystemTrash(plan.sidecars).catch(() => {});
  const sidecars = gone(plan.sidecars);
  return { moved: true, trashed: [...plan.files, ...sidecars], sidecars: sidecars.length };
}

/** The files among `paths` the library already holds the same bytes of, grouped with their RAW or
 *  JPG partner, and (unless `dryRun`) sent to the Trash. */
export async function clearKnownSources(
  userId: string,
  paths: string[],
  dryRun: boolean,
): Promise<{
  cleared: number;
  sidecars: number;
  trashed: string[];
  kept: Array<{ path: string; reason: TrashBlock }>;
}> {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = path.join(path.dirname(p), stemOf(p));
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let cleared = 0;
  let sidecars = 0;
  const trashed: string[] = [];
  const kept: Array<{ path: string; reason: TrashBlock }> = [];
  await mapWithConcurrency([...groups.values()], 4, async (members) => {
    const group = members.map((m) => ({ path: m }));
    const out: TrashOutcome = dryRun
      ? await planGroup(userId, group).then((plan) =>
          typeof plan === "string"
            ? { moved: false, reason: plan, trashed: [], sidecars: 0 }
            : { moved: true, trashed: [], sidecars: plan.sidecars.length },
        )
      : await trashSourceGroup(userId, group);
    trashed.push(...out.trashed);
    if (out.moved) {
      cleared += members.length;
      sidecars += out.sidecars;
    } else for (const m of members) kept.push({ path: m, reason: out.reason! });
  });
  return { cleared, sidecars, trashed, kept };
}
