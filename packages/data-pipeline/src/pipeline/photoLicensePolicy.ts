// Keeps the maintainer database to photos the project may redistribute (@lifer/core/species/licensePolicy.ts's
// isPublishableLicense), since packs, the photo store and the catalog seed are built from it.
//
// Enrichment (packages/core/src/species/lazyEnrich.ts) stores a species' iNaturalist photos whatever
// their license: on someone's own install that's personal viewing, like opening iNaturalist. The
// pipeline runs the same enrichment, so before anything is published:
//   - gallery photos with a license that can't be published are removed;
//   - a species whose main photo can't be published gets its first publishable gallery photo
//     instead, or no photo when there's none, marked species.photo_withheld so installs fetch it
//     for personal viewing (migration 123);
//   - that species' main-photo vectors are dropped, so the vectors stage recomputes them from the
//     new photo (gallery vectors go with their row, ON DELETE CASCADE).
// Enrichment runs this when it finishes (enrich-all-species.ts, recheck-null-photo-species.ts),
// before the vectors stage, and the photo store and pack builds refuse to run while anything
// unpublishable is left (assertPhotosPublishable).
import type { Pool, PoolClient } from "pg";
import { isPublishableLicense } from "@lifer/core/species/licensePolicy.js";

export interface MainPhoto {
  speciesId: string;
  license: string | null;
}

export interface GalleryPhoto {
  id: string;
  speciesId: string;
  license: string | null;
  sortOrder: number;
}

export interface PhotoLicensePlan {
  /** Gallery rows to delete: unpublishable ones, plus the ones promoted to main photo. */
  deleteGalleryIds: string[];
  /** Species whose main photo becomes this (publishable) gallery photo. */
  promote: Array<{ speciesId: string; galleryId: string }>;
  /** Species left with no main photo. */
  clear: string[];
}

/** Decides what to change. `mains` are species that have a main photo. */
export function planPhotoLicenseFixes(mains: MainPhoto[], gallery: GalleryPhoto[]): PhotoLicensePlan {
  const deleteGalleryIds: string[] = [];
  const publishableBySpecies = new Map<string, GalleryPhoto[]>();
  for (const photo of gallery) {
    if (!isPublishableLicense(photo.license)) {
      deleteGalleryIds.push(photo.id);
      continue;
    }
    const list = publishableBySpecies.get(photo.speciesId) ?? [];
    list.push(photo);
    publishableBySpecies.set(photo.speciesId, list);
  }

  const promote: PhotoLicensePlan["promote"] = [];
  const clear: string[] = [];
  for (const main of mains) {
    if (isPublishableLicense(main.license)) continue;
    const replacement = (publishableBySpecies.get(main.speciesId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder)[0];
    if (replacement) {
      promote.push({ speciesId: main.speciesId, galleryId: replacement.id });
      deleteGalleryIds.push(replacement.id);
    } else {
      clear.push(main.speciesId);
    }
  }
  return { deleteGalleryIds, promote, clear };
}

/** Applies the policy in one transaction and reports what changed. Safe to re-run. */
export async function applyPhotoLicensePolicy(
  db: Pool,
  log: (m: string) => void = (m) => console.log(`[photo-licenses] ${m}`),
): Promise<PhotoLicensePlan> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const plan = await applyPhotoLicensePolicyWith(client);
    await client.query("COMMIT");
    log(
      `${plan.promote.length} main photo(s) replaced with a publishable gallery photo, ${plan.clear.length} cleared, ` +
        `${plan.deleteGalleryIds.length - plan.promote.length} gallery photo(s) removed`,
    );
    return plan;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The policy on a client whose transaction the caller manages. */
export async function applyPhotoLicensePolicyWith(client: PoolClient): Promise<PhotoLicensePlan> {
  const mains = (
    await client.query<{ species_id: string; license: string | null }>(
      `SELECT id AS species_id, reference_license AS license FROM species WHERE reference_photo IS NOT NULL`,
    )
  ).rows.map((r) => ({ speciesId: r.species_id, license: r.license }));
  const gallery = (
    await client.query<{ id: string; species_id: string; license: string | null; sort_order: number }>(
      `SELECT id, species_id, license, sort_order FROM species_reference_photos`,
    )
  ).rows.map((r) => ({ id: r.id, speciesId: r.species_id, license: r.license, sortOrder: r.sort_order }));

  const plan = planPhotoLicenseFixes(mains, gallery);
  await applyPlan(client, plan);
  return plan;
}

async function applyPlan(client: PoolClient, plan: PhotoLicensePlan): Promise<void> {
  for (const { speciesId, galleryId } of plan.promote) {
    await client.query(
      `UPDATE species s
       SET reference_photo = p.photo_url, reference_credit = p.credit, reference_license = p.license,
           reference_display_path = p.display_path, reference_thumb_path = p.thumb_path,
           reference_focal_x = p.focal_x, reference_focal_y = p.focal_y
       FROM species_reference_photos p
       WHERE s.id = $1 AND p.id = $2`,
      [speciesId, galleryId],
    );
  }
  if (plan.clear.length > 0) {
    await client.query(
      `UPDATE species
       SET reference_photo = NULL, reference_credit = NULL, reference_license = NULL,
           reference_display_path = NULL, reference_thumb_path = NULL,
           reference_focal_x = NULL, reference_focal_y = NULL, photo_withheld = true
       WHERE id = ANY($1)`,
      [plan.clear],
    );
  }
  // Every main photo left is publishable now (promoted or already so), so none is withheld.
  await client.query(`UPDATE species SET photo_withheld = false WHERE photo_withheld AND reference_photo IS NOT NULL`);
  const changedMains = [...plan.promote.map((p) => p.speciesId), ...plan.clear];
  if (changedMains.length > 0) {
    // Computed from the old main photo; the vectors stage recomputes missing ones.
    await client.query(`DELETE FROM species_reference_embeddings WHERE species_id = ANY($1)`, [changedMains]);
    await client.query(`DELETE FROM id_model_reference_embeddings WHERE species_id = ANY($1)`, [changedMains]);
  }
  if (plan.deleteGalleryIds.length > 0) {
    await client.query(`DELETE FROM species_reference_photos WHERE id = ANY($1)`, [plan.deleteGalleryIds]);
  }
}

/** Throws when the database still holds a photo the project may not publish. */
export async function assertPhotosPublishable(db: Pool): Promise<void> {
  const mains = await db.query<{ license: string | null }>(
    `SELECT reference_license AS license FROM species WHERE reference_photo IS NOT NULL`,
  );
  const gallery = await db.query<{ license: string | null }>(`SELECT license FROM species_reference_photos`);
  const bad = [...mains.rows, ...gallery.rows].filter((r) => !isPublishableLicense(r.license)).length;
  if (bad > 0) {
    throw new Error(
      `${bad} photo(s) in the database have a license that can't be published. ` +
        "Run `npm run apply-photo-licenses -w data-pipeline` (the enrich stage also does this), then the vectors stage.",
    );
  }
}
