// Photo versions: edits and exports of one photographed moment, grouped so the moment counts once.
// Every file keeps its own capture; a version's capture is hidden behind its group's capture
// (capture_versions), so a split brings it back exactly as it was. Wrong merges are worse than
// missed ones: only a shared XMP document ID, or the same shutter press (time, sub-second and body
// serial) with a stem that differs by a known suffix, link on their own. The same press alone is
// only suggested for a person to confirm. File size and dimensions are never a signal.
import path from "node:path";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { createJob } from "../lib/job.js";
import { resolveOriginalPaths } from "../storageVolumes/resolve.js";
import { hideCapturesTx, unhideCapturesTx, type HiddenCover } from "../captures/hidden.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { readVersionTags } from "./exif.js";
import { lastOriginalInsertAt } from "./captureRows.js";

export type FileRole = "original" | "edit" | "export";
export type VersionEvidence = "document_id" | "time_serial_suffix" | "suggested" | "manual" | "version_folder";

// What editors and exporters append to a name: "-2", "-Edit", "-Enhanced-NR", "-Pano", "-HDR",
// black and white ("-BW", "_bw", "1234bw"), or a print size such as "_10x27" or " 16x20".
// Underscore digits are left alone: "DSC_0001" is a camera name.
const SUFFIX =
  /(?:-(?:\d{1,3}|edit(?:ed)?|enhanced(?:-nr|-sr)?|nr|pano(?:rama)?|hdr|copy)|[-_ ](?:bw|b&w|mono)|(?<=\d)bw|[-_ ]\d{1,3}x\d{1,3})$/i;

/** Folders whose files are versions of the original beside them, unless the user lists others. */
export const DEFAULT_VERSION_FOLDERS = [
  "Prints",
  "Print",
  "Versions",
  "Edits",
  "Exports",
  "B&W",
  "BW",
  "Black and White",
  "Mono",
];

const posix = (ref: string) => ref.replace(/\\/g, "/");
const folderOf = (ref: string) => path.posix.basename(path.posix.dirname(posix(ref))).toLowerCase();

/** The user's version folder names, lower case. */
export async function versionFoldersFor(userId: string): Promise<Set<string>> {
  const res = await pool.query<{ names: string[] | null }>(
    `SELECT version_folder_names AS names FROM users WHERE id = $1`,
    [userId],
  );
  return new Set((res.rows[0]?.names ?? DEFAULT_VERSION_FOLDERS).map((n) => n.toLowerCase()));
}

export type VersionLabelKind = "original" | "edit" | "export" | "print" | "bw" | "pano" | "enhanced" | "hdr";

const BW_FOLDER = /^(?:b&w|bw|black and white|black & white|mono|monochrome)$/i;

/** What to call a version when its owner hasn't named it, from its name, folder and role. */
export function versionLabel(ref: string, role: FileRole | null): { kind: VersionLabelKind; size: string | null } {
  const stem = path.posix.basename(posix(ref), path.extname(ref)).toLowerCase();
  const folder = folderOf(ref);
  const size = /(?:^|[-_ ])(\d{1,3}x\d{1,3})(?=$|[-_ ])/.exec(stem)?.[1] ?? null;
  const kind: VersionLabelKind =
    /(?:^|[-_ ])(?:bw|b&w|mono)(?=$|[-_ ])|\dbw$/.test(stem) || BW_FOLDER.test(folder)
      ? "bw"
      : size || folder === "prints" || folder === "print"
        ? "print"
        : /-pano(?:rama)?(?=$|-)/.test(stem)
          ? "pano"
          : /-enhanced(?=$|-)/.test(stem)
            ? "enhanced"
            : /-hdr(?=$|-)/.test(stem)
              ? "hdr"
              : (role ?? "original");
  return { kind, size };
}
const EDIT_FORMATS = new Set([".dng", ".tif", ".tiff", ".psd", ".psb"]);
const EDITOR_SOFTWARE =
  /lightroom|photoshop|camera raw|capture one|dxo|topaz|luminar|darktable|rawtherapee|gimp|affinity|on1|pixelmator|acdsee/i;

/** The name a file's versions share: no folder, extension or editor suffixes, lower case. */
export function baseStem(fileName: string): string {
  let stem = path.basename(fileName.replace(/\\/g, "/"), path.extname(fileName)).toLowerCase();
  for (let next = stem.replace(SUFFIX, ""); next !== stem && next.length > 0; next = stem.replace(SUFFIX, "")) {
    stem = next;
  }
  return stem;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// "xmp.did:6F3B-..." and "6F3B..." name one document.
function normaliseDocumentId(id: string | null): string | null {
  if (!id) return null;
  const bare = id
    .slice(id.lastIndexOf(":") + 1)
    .replace(/[^0-9a-z]/gi, "")
    .toLowerCase();
  return bare.length >= 8 ? bare.slice(0, 200) : null;
}

/** A file's role and the document it descends from, from its name and XMP. */
export function classifyFile(
  fileName: string,
  tags: Record<string, unknown>,
  /** The file sits in a version folder (Prints, B&W...), so it's never the camera original. */
  inVersionFolder = false,
): { role: FileRole; documentId: string | null } {
  const own = normaliseDocumentId(text(tags.DocumentID));
  const origin = normaliseDocumentId(
    text(tags.OriginalDocumentID) ?? text(tags.DerivedFromOriginalDocumentID) ?? text(tags.DerivedFromDocumentID),
  );
  const ext = path.extname(fileName).toLowerCase();
  const derived =
    inVersionFolder ||
    (origin != null && origin !== own) ||
    baseStem(fileName) !== path.basename(fileName.replace(/\\/g, "/"), path.extname(fileName)).toLowerCase() ||
    EDITOR_SOFTWARE.test(text(tags.Software) ?? "");
  const role: FileRole = !derived ? "original" : EDIT_FORMATS.has(ext) ? "edit" : "export";
  return { role, documentId: origin ?? own };
}

interface Press {
  subSec: boolean;
  serial: boolean;
}

/** Hides `versionId` behind `groupId` and records why. False when either is gone, not the user's,
 *  or the link would nest groups (a linked version as the group, or a version with its own). */
export async function linkVersionTx(
  client: PoolClient,
  userId: string,
  versionId: string,
  groupId: string,
  evidence: VersionEvidence,
  after: { covers: HiddenCover[]; recrop: string[] },
): Promise<boolean> {
  if (versionId === groupId) return false;
  const ok = await client.query(
    `SELECT 1 FROM captures_all c
     WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2 AND c.deleted_at IS NULL
     HAVING count(*) = 2
       AND NOT EXISTS (SELECT 1 FROM capture_versions WHERE capture_id = $3 AND state = 'linked')
       AND NOT EXISTS (SELECT 1 FROM capture_versions WHERE group_capture_id = $4 AND state = 'linked')`,
    [[versionId, groupId], userId, groupId, versionId],
  );
  if (ok.rowCount !== 1) return false;
  const hid = (await hideCapturesTx(client, userId, [versionId], after.covers, after.recrop)).length === 1;
  // Re-linking a split keeps the evidence it was first linked on.
  await client.query(
    `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state, hid_capture, decided_at)
     VALUES ($1, $2, $3, $4, 'linked', $5, now())
     ON CONFLICT (capture_id) DO UPDATE SET
       evidence = CASE WHEN capture_versions.group_capture_id = EXCLUDED.group_capture_id
                       AND capture_versions.state <> 'suggested'
                  THEN capture_versions.evidence ELSE EXCLUDED.evidence END,
       group_capture_id = EXCLUDED.group_capture_id, state = 'linked',
       hid_capture = EXCLUDED.hid_capture, displayed = false, decided_at = now()`,
    [versionId, groupId, userId, evidence, hid],
  );
  return true;
}

/** Swaps two captures' shown photos (rows and covers), so the group's capture shows a version's
 *  file while each file keeps its own capture. Returns species whose card crop was reset. */
async function swapPhotos(client: PoolClient, groupId: string, versionId: string): Promise<string[]> {
  const res = await client.query<{ id: string; current_photo_id: string | null }>(
    `SELECT id, current_photo_id FROM captures_all WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [[groupId, versionId]],
  );
  const shown = res.rows.find((r) => r.id === groupId)?.current_photo_id;
  const other = res.rows.find((r) => r.id === versionId)?.current_photo_id;
  if (!shown || !other) return [];
  await client.query(
    `UPDATE photos SET capture_id = CASE WHEN id = $1 THEN $4::uuid ELSE $3::uuid END WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
    [shown, other, groupId, versionId],
  );
  await client.query(
    `UPDATE captures_all SET current_photo_id = CASE WHEN id = $1 THEN $3::uuid ELSE $4::uuid END, updated_at = now()
     WHERE id = ANY(ARRAY[$1, $2]::uuid[])`,
    [groupId, versionId, other, shown],
  );
  // The group's card and album covers follow it to the newly shown photo. Only the group's own
  // species: a version linked from another species keeps that species' hand-picked cover.
  await client.query(`UPDATE albums SET cover_photo_id = $2 WHERE cover_photo_id = $1`, [shown, other]);
  const ownSpecies = `species_id IN (SELECT species_id FROM captures_all WHERE id = $3
                      UNION SELECT species_id FROM capture_species WHERE capture_id = $3)`;
  await client.query(
    `UPDATE user_species SET cover_chosen_photo_id = $2 WHERE cover_chosen_photo_id = $1 AND ${ownSpecies}`,
    [shown, other, groupId],
  );
  const covers = await client.query<{ species_id: string }>(
    `UPDATE user_species SET cover_photo_id = $2, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
     WHERE cover_photo_id = $1 AND ${ownSpecies} RETURNING species_id`,
    [shown, other, groupId],
  );
  return covers.rows.map((r) => r.species_id);
}

/** Shows `versionId`'s file as the group's photo, or the group capture's own with null. */
export async function showVersionTx(
  client: PoolClient,
  groupId: string,
  versionId: string | null,
  recrop: string[],
): Promise<void> {
  const current = await client.query<{ capture_id: string }>(
    `SELECT capture_id FROM capture_versions WHERE group_capture_id = $1 AND state = 'linked' AND displayed`,
    [groupId],
  );
  const shown = current.rows[0]?.capture_id ?? null;
  if (shown === versionId) return;
  if (shown) {
    recrop.push(...(await swapPhotos(client, groupId, shown)));
    await client.query(`UPDATE capture_versions SET displayed = false WHERE capture_id = $1`, [shown]);
  }
  if (versionId) {
    recrop.push(...(await swapPhotos(client, groupId, versionId)));
    await client.query(`UPDATE capture_versions SET displayed = true WHERE capture_id = $1`, [versionId]);
  }
}

/** Returns a linked version to its own capture. The group capture id, for an undo, or null. */
export async function splitVersionTx(
  client: PoolClient,
  userId: string,
  versionId: string,
  after: { species: Set<string>; recrop: string[] },
): Promise<string | null> {
  const res = await client.query<{ group_capture_id: string; hid_capture: boolean; displayed: boolean }>(
    `SELECT group_capture_id, hid_capture, displayed FROM capture_versions
     WHERE capture_id = $1 AND user_id = $2 AND state = 'linked' FOR UPDATE`,
    [versionId, userId],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.displayed) await showVersionTx(client, row.group_capture_id, null, after.recrop);
  // Kept as dismissed, so the rules never link it again on their own.
  await client.query(
    `UPDATE capture_versions SET state = 'dismissed', displayed = false, decided_at = now() WHERE capture_id = $1`,
    [versionId],
  );
  if (row.hid_capture) {
    await unhideCapturesTx(client, userId, [versionId], after.species);
    // Linking moved a hand-picked featured photo off it; it comes back with the photo.
    const covers = await client.query<{ species_id: string }>(
      `UPDATE user_species us SET cover_photo_id = us.cover_chosen_photo_id,
         card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
       FROM photos p
       WHERE us.user_id = $1 AND p.id = us.cover_chosen_photo_id AND p.capture_id = $2
         AND us.cover_photo_id IS DISTINCT FROM us.cover_chosen_photo_id
       RETURNING us.species_id`,
      [userId, versionId],
    );
    after.recrop.push(...covers.rows.map((r) => r.species_id));
  }
  return row.group_capture_id;
}

/** Runs `fn` in a transaction, then the after-commit bookkeeping hiding and unhiding needs. */
export async function withVersionChanges<T>(
  userId: string,
  fn: (client: PoolClient, after: { covers: HiddenCover[]; recrop: string[]; species: Set<string> }) => Promise<T>,
): Promise<T> {
  const after = { covers: [] as HiddenCover[], recrop: [] as string[], species: new Set<string>() };
  const result = await withTransaction((client) => fn(client, after));
  invalidateUserVectors(userId);
  for (const speciesId of new Set([...after.recrop, ...after.species])) ensureDefaultCardCropLater(userId, speciesId);
  return result;
}

// The capture a candidate is shown under: its group's when it's a linked version.
async function groupsOf(client: PoolClient, captureIds: string[]): Promise<string[]> {
  if (captureIds.length === 0) return [];
  const res = await client.query<{ head: string }>(
    `SELECT DISTINCT COALESCE(cv.group_capture_id, c.id) AS head
     FROM unnest($1::uuid[]) AS c(id)
     LEFT JOIN capture_versions cv ON cv.capture_id = c.id AND cv.state = 'linked'`,
    [captureIds],
  );
  return res.rows.map((r) => r.head);
}

async function namesOf(client: PoolClient, captureId: string): Promise<{ stems: Set<string>; documents: Set<string> }> {
  const res = await client.query<{ ref: string; document_id: string | null }>(
    `SELECT ref, document_id FROM originals WHERE capture_id = $1 AND kind IN ('jpeg', 'raw')`,
    [captureId],
  );
  return {
    stems: new Set(res.rows.map((r) => baseStem(r.ref))),
    documents: new Set(res.rows.flatMap((r) => (r.document_id ? [r.document_id] : []))),
  };
}

/** Links one capture by the two rules that act alone, strongest first. `pending`: captures of
 *  this pass not reached yet, which rank no higher, so they join this one rather than the reverse. */
async function linkCapture(
  client: PoolClient,
  userId: string,
  captureId: string,
  press: Press,
  pending: Set<string>,
  after: { covers: HiddenCover[]; recrop: string[] },
): Promise<boolean> {
  if (await decided(client, captureId)) return false;

  // Joins the one settled group the evidence points at, or gathers pending matches under this
  // capture. Two settled groups is ambiguous, and nothing moves.
  const settle = async (candidates: string[], evidence: VersionEvidence): Promise<boolean | null> => {
    const heads = (await groupsOf(client, candidates)).filter((g) => g !== captureId);
    if (heads.length === 0) return null;
    const settled = heads.filter((h) => !pending.has(h));
    if (settled.length > 1) return false;
    if (settled.length === 1) {
      if (!(await linkVersionTx(client, userId, captureId, settled[0], evidence, after))) return false;
      await showPreferredVersion(client, settled[0], after.recrop);
      return true;
    }
    let linked = false;
    for (const h of heads) linked = (await linkVersionTx(client, userId, h, captureId, evidence, after)) || linked;
    if (linked) await showPreferredVersion(client, captureId, after.recrop);
    return linked;
  };

  // (1) A shared XMP document.
  const byDocument = await client.query<{ capture_id: string }>(
    `SELECT DISTINCT o2.capture_id FROM originals o1
     JOIN originals o2 ON o2.user_id = o1.user_id AND o2.document_id = o1.document_id AND o2.capture_id <> o1.capture_id
     JOIN captures_all c2 ON c2.id = o2.capture_id AND c2.deleted_at IS NULL
     WHERE o1.capture_id = $1 AND o1.document_id IS NOT NULL`,
    [captureId],
  );
  const byDocumentResult = await settle(
    byDocument.rows.map((r) => r.capture_id),
    "document_id",
  );
  if (byDocumentResult != null) return byDocumentResult;

  // (2) The same shutter press (time, sub-second, body and serial: the strict fingerprint) and a
  // name that differs only by an editor's suffix.
  if (!press.serial || !press.subSec) return false;
  const mine = await namesOf(client, captureId);
  const sameStem: string[] = [];
  for (const id of await samePress(client, captureId)) {
    const theirs = await namesOf(client, id);
    // Both carry a document and they differ: two documents, whatever the names say.
    const otherDocument = mine.documents.size > 0 && theirs.documents.size > 0;
    if (!otherDocument && [...theirs.stems].some((s) => mine.stems.has(s))) sameStem.push(id);
  }
  return (await settle(sameStem, "time_serial_suffix")) ?? false;
}

async function decided(client: PoolClient, captureId: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM capture_versions WHERE capture_id = $1 AND state IN ('linked', 'dismissed')`,
    [captureId],
  );
  return (res.rowCount ?? 0) > 0;
}

async function samePress(client: PoolClient, captureId: string): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT c2.id FROM captures_all c1
     JOIN captures_all c2 ON c2.user_id = c1.user_id AND c2.exif_fingerprint = c1.exif_fingerprint
       AND c2.id <> c1.id AND c2.deleted_at IS NULL
     WHERE c1.id = $1 AND c1.exif_fingerprint IS NOT NULL`,
    [captureId],
  );
  return res.rows.map((r) => r.id);
}

/** (3) The same press and serial alone, after linking: offered for a person to confirm. A group,
 *  or a capture already offered as one, is never itself offered as a version. */
async function suggestCapture(client: PoolClient, userId: string, captureId: string, press: Press): Promise<boolean> {
  if (!press.serial || (await decided(client, captureId))) return false;
  const isGroup = await client.query(
    `SELECT 1 FROM capture_versions WHERE group_capture_id = $1 AND state IN ('linked', 'suggested')`,
    [captureId],
  );
  if (isGroup.rowCount) return false;
  const heads = (await groupsOf(client, await samePress(client, captureId))).filter((g) => g !== captureId);
  if (heads.length !== 1) return false;
  const res = await client.query(
    `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state)
     VALUES ($1, $2, $3, 'suggested', 'suggested') ON CONFLICT (capture_id) DO NOTHING`,
    [captureId, heads[0], userId],
  );
  return (res.rowCount ?? 0) > 0;
}

const likePrefix = (dir: string) => `${dir.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;

/** (5) A file in a version folder (`Moose/Prints/IMG_1-8x10.jpg`) and a file with the same name
 *  beside that folder or in a sibling one (`Moose/IMG_1.CR3`, `Moose/RAW/IMG_1.CR3`). Linked
 *  when the press (time, sub-second, body and serial) matches too, otherwise only suggested. The
 *  folder name alone never links anything: the names must match. */
async function folderRule(
  client: PoolClient,
  userId: string,
  captureId: string,
  press: Press,
  folders: Set<string>,
  after: { covers: HiddenCover[]; recrop: string[] },
): Promise<"linked" | "suggested" | null> {
  if (folders.size === 0 || (await decided(client, captureId))) return null;
  const own = await client.query<{ ref: string }>(
    `SELECT ref FROM originals WHERE capture_id = $1 AND kind IN ('jpeg', 'raw')`,
    [captureId],
  );
  const matches = new Set<string>();
  for (const { ref } of own.rows) {
    if (!folders.has(folderOf(ref))) continue;
    const parent = path.posix.dirname(path.posix.dirname(posix(ref)));
    const stem = baseStem(ref);
    const res = await client.query<{ capture_id: string; ref: string }>(
      `SELECT o.capture_id, o.ref FROM originals o
       JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
       WHERE o.user_id = $1 AND o.capture_id <> $2 AND o.kind IN ('jpeg', 'raw')
         AND replace(o.ref, '\\', '/') LIKE $3 ESCAPE '\\'
         AND strpos(lower(o.ref), $4) > 0`,
      [userId, captureId, likePrefix(parent), stem],
    );
    for (const r of res.rows) {
      const dir = path.posix.dirname(posix(r.ref));
      const besideOrSibling = dir === parent || (path.posix.dirname(dir) === parent && !folders.has(folderOf(r.ref)));
      if (besideOrSibling && baseStem(r.ref) === stem) matches.add(r.capture_id);
    }
  }
  const heads = (await groupsOf(client, [...matches])).filter((g) => g !== captureId);
  if (heads.length !== 1) return null;
  const pressMatches = press.serial && (await samePress(client, captureId)).some((id) => matches.has(id));
  if (pressMatches && (await linkVersionTx(client, userId, captureId, heads[0], "version_folder", after))) {
    await showPreferredVersion(client, heads[0], after.recrop);
    return "linked";
  }
  const res = await client.query(
    `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state)
     VALUES ($1, $2, $3, 'version_folder', 'suggested') ON CONFLICT (capture_id) DO NOTHING`,
    [captureId, heads[0], userId],
  );
  return (res.rowCount ?? 0) > 0 ? "suggested" : null;
}

/** With no file chosen by hand, a group shows its newest edit, else its camera original. An
 *  export is only shown when the user picks it. */
async function showPreferredVersion(client: PoolClient, groupId: string, recrop: string[]): Promise<void> {
  const res = await client.query<{ capture_id: string; is_group: boolean; displayed: boolean; rank: number }>(
    `SELECT m.capture_id, m.capture_id = $1 AS is_group, COALESCE(cv.displayed, false) AS displayed,
            min(CASE o.role WHEN 'edit' THEN 0 WHEN 'original' THEN 1 ELSE 2 END) AS rank,
            max(o.verified_mtime) AS newest
     FROM (SELECT $1::uuid AS capture_id
           UNION SELECT capture_id FROM capture_versions WHERE group_capture_id = $1 AND state = 'linked') m
     JOIN originals o ON o.capture_id = m.capture_id
     LEFT JOIN capture_versions cv ON cv.capture_id = m.capture_id
     GROUP BY m.capture_id, cv.displayed
     ORDER BY rank, is_group DESC, newest DESC NULLS LAST`,
    [groupId],
  );
  // shortcut: a pick of the group's own file isn't recorded, so a later edit can replace it; record it if that bothers anyone.
  if (res.rows.some((r) => r.displayed && r.rank === 2)) return;
  const best = res.rows[0];
  if (!best) return;
  await showVersionTx(client, groupId, best.is_group ? null : best.capture_id, recrop);
}

export const versionGroupingJob = createJob<{ linked: number; suggested: number }>("version-grouping");

interface PendingFile {
  id: string;
  capture_id: string;
  user_id: string;
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
}

const BATCH = 200;

/** One user's folder (and everything under it), for "Look for versions in this folder". */
export interface FolderScope {
  userId: string;
  folder: string;
}

// The files a pass reads: every file not classified yet, or, in one folder, every file whose
// capture has no decision yet (a person's split or link is never revisited).
function pendingFilesSql(scope: FolderScope | null, params: unknown[]): string {
  if (!scope) return `role IS NULL AND capture_id IS NOT NULL AND kind IN ('jpeg', 'raw')`;
  const folder = posix(scope.folder).replace(/\/+$/, "");
  params.push(scope.userId, folder, likePrefix(folder));
  const n = params.length;
  return `user_id = $${n - 2} AND capture_id IS NOT NULL AND kind IN ('jpeg', 'raw')
    AND (replace(ref, '\\', '/') = $${n - 1} OR replace(ref, '\\', '/') LIKE $${n} ESCAPE '\\')
    AND NOT EXISTS (SELECT 1 FROM capture_versions d WHERE d.capture_id = originals.capture_id
                    AND d.state IN ('linked', 'dismissed'))`;
}

/** Reads every file not classified yet (or every undecided file in one folder), then groups
 *  their captures. Resumable: a file is only pending until its role is written, and a decided
 *  capture is never grouped again. False when a pass is already running. */
export function startVersionGroupingPass(scope: FolderScope | null = null): boolean {
  return versionGroupingJob.start(async (ctx) => {
    const totals = { linked: 0, suggested: 0 };
    const countParams: unknown[] = [];
    const total = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM originals WHERE ${pendingFilesSql(scope, countParams)}`,
      countParams,
    );
    ctx.update({ total: Number(total.rows[0]?.n ?? 0), processed: 0 });
    let processed = 0;
    let cursor = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      ctx.throwIfCancelled();
      const params: unknown[] = [cursor, BATCH];
      const batch = await pool.query<PendingFile>(
        `SELECT id, capture_id, user_id, ref, volume_id, volume_relative_path FROM originals
         WHERE ${pendingFilesSql(scope, params)} AND id > $1
         ORDER BY id LIMIT $2`,
        params,
      );
      if (batch.rows.length === 0) break;
      cursor = batch.rows[batch.rows.length - 1].id;
      // shortcut: a stop between writing roles and linking leaves that batch unlinked until a person links it; add a "grouped" marker if that shows up.
      const folders = new Map<string, Set<string>>();
      for (const userId of new Set(batch.rows.map((r) => r.user_id)))
        folders.set(userId, await versionFoldersFor(userId));
      const press = await classifyBatch(batch.rows, folders);
      const result = await groupBatch(press, folders);
      totals.linked += result.linked;
      totals.suggested += result.suggested;
      processed += batch.rows.length;
      ctx.update({ processed });
    }
    return totals;
  });
}

/** startVersionGroupingPass, waiting for it to finish. */
export async function runVersionGroupingPass(
  scope: FolderScope | null = null,
): Promise<{ linked: number; suggested: number }> {
  const started = startVersionGroupingPass(scope);
  await versionGroupingJob.settled();
  return (started && versionGroupingJob.status.result) || { linked: 0, suggested: 0 };
}

/** Writes each readable file's role and document; returns what each capture's files say about
 *  the shutter press. A file on a disconnected drive waits for a later pass. */
async function classifyBatch(files: PendingFile[], folders: Map<string, Set<string>>): Promise<Map<string, Press>> {
  const press = new Map<string, Press>();
  const resolved = await resolveOriginalPaths(files);
  for (const [i, file] of files.entries()) {
    const filePath = resolved[i].path;
    if (!filePath) continue;
    let tags: Record<string, unknown> = {};
    try {
      tags = await readVersionTags(filePath);
    } catch {
      // Unreadable metadata: it stays a photo of its own until a person links it.
    }
    const { role, documentId } = classifyFile(file.ref, tags, folders.get(file.user_id)?.has(folderOf(file.ref)));
    await pool.query(`UPDATE originals SET role = $1, document_id = $2 WHERE id = $3`, [role, documentId, file.id]);
    const p = press.get(file.capture_id) ?? { subSec: false, serial: false };
    press.set(file.capture_id, {
      subSec: p.subSec || text(String(tags.SubSecTimeOriginal ?? "")) != null,
      serial: p.serial || text(String(tags.SerialNumber ?? "")) != null,
    });
  }
  return press;
}

async function groupBatch(
  press: Map<string, Press>,
  folders: Map<string, Set<string>>,
): Promise<{ linked: number; suggested: number }> {
  const totals = { linked: 0, suggested: 0 };
  // Strongest file first, so the camera original becomes the group's capture.
  const order = await pool.query<{ id: string; user_id: string }>(
    `SELECT c.id, c.user_id FROM captures_all c JOIN originals o ON o.capture_id = c.id
     WHERE c.id = ANY($1::uuid[]) AND c.deleted_at IS NULL
     GROUP BY c.id
     ORDER BY min(CASE o.role WHEN 'original' THEN 0 WHEN 'edit' THEN 1 ELSE 2 END), c.created_at, c.id`,
    [[...press.keys()]],
  );
  const pending = new Set(order.rows.map((r) => r.id));
  for (const { id, user_id } of order.rows) {
    pending.delete(id);
    const outcome = await withVersionChanges(user_id, async (client, after) =>
      (await linkCapture(client, user_id, id, press.get(id)!, pending, after))
        ? "linked"
        : folderRule(client, user_id, id, press.get(id)!, folders.get(user_id) ?? new Set(), after),
    );
    if (outcome === "linked") totals.linked++;
    if (outcome === "suggested") totals.suggested++;
  }
  // Weakest first, so an export is offered as a version of the camera file.
  for (const { id, user_id } of [...order.rows].reverse()) {
    if (await withTransaction((client) => suggestCapture(client, user_id, id, press.get(id)!))) totals.suggested++;
  }
  return totals;
}

const IMPORT_QUIET_MS = 15_000;
const TICK_MS = 20_000;

/** Groups new files once imports go quiet, so a long import never waits on it. */
export function scheduleVersionGrouping(): void {
  const tick = async () => {
    if (versionGroupingJob.status.running || Date.now() - lastOriginalInsertAt < IMPORT_QUIET_MS) return;
    const any = await pool.query(
      `SELECT 1 FROM originals WHERE role IS NULL AND capture_id IS NOT NULL AND kind IN ('jpeg', 'raw') LIMIT 1`,
    );
    if (any.rowCount) startVersionGroupingPass();
  };
  setInterval(() => void tick().catch((err) => log.warn({ err }, "[version-grouping] pass failed")), TICK_MS).unref();
}
