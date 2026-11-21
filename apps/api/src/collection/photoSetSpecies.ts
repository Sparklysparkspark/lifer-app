// The species cards of an album or trip, each showing that set's own best photo of the species
// rather than its featured one, so the Species view stays on the set's theme.
import { pool } from "@lifer/core/db.js";
import { knownDefaultCrops } from "../albums/defaultCoverCrops.js";
import { markNameChanged } from "../species/speciesSplits.js";
import { toCollectionItem, type CollectionRow } from "./collectionItem.js";

export interface SetPhoto {
  species_id: string;
  photo_id: string;
  quality_rating: number | null;
}

/** Each species' best photo: the highest rated, then the first in `photos` order. */
export function bestPhotoBySpecies(photos: SetPhoto[]): Map<string, string> {
  const best = new Map<string, SetPhoto>();
  for (const p of photos) {
    const current = best.get(p.species_id);
    if (!current || (p.quality_rating ?? 0) > (current.quality_rating ?? 0)) best.set(p.species_id, p);
  }
  return new Map([...best].map(([speciesId, p]) => [speciesId, p.photo_id]));
}

/** Same shape as /collection items. A species with no photo in `photos` keeps its featured one. */
export async function photoSetSpeciesCards(userId: string, speciesIds: string[], photos: SetPhoto[]) {
  const picks = bestPhotoBySpecies(photos);
  const res = await pool.query<CollectionRow & { picked: boolean }>(
    `WITH pick AS (SELECT * FROM unnest($2::uuid[], $3::uuid[]) AS x(species_id, photo_id))
     SELECT
       s.id AS species_id,
       s.scientific_name,
       s.common_name,
       s.aba_code,
       s.ebird_code,
       s.taxon_class,
       s.family,
       s.taxon_order,
       s.reference_photo,
       s.reference_credit,
       s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
       s.reference_focal_x,
       s.reference_focal_y,
       r.tier,
       t.endemic_country_iso3,
       t.endemic_region_label,
       us.state,
       us.is_target,
       us.needs_better_photo,
       COALESCE(pick.photo_id, us.cover_photo_id) AS cover_photo_id,
       pick.photo_id IS NOT NULL AS picked,
       -- The featured photo's crop lives on user_species, any other photo's on the photo itself.
       CASE WHEN pick.photo_id IS NULL OR pick.photo_id = us.cover_photo_id THEN us.card_crop_x ELSE p.card_crop_x END AS card_crop_x,
       CASE WHEN pick.photo_id IS NULL OR pick.photo_id = us.cover_photo_id THEN us.card_crop_y ELSE p.card_crop_y END AS card_crop_y,
       CASE WHEN pick.photo_id IS NULL OR pick.photo_id = us.cover_photo_id THEN us.card_crop_size ELSE p.card_crop_size END AS card_crop_size,
       p.thumb_path IS NOT NULL AS has_cover_photo,
       sv.label AS cover_volume_label
     FROM species s
     LEFT JOIN pick ON pick.species_id = s.id
     LEFT JOIN species_rarity r ON r.species_id = s.id
     LEFT JOIN species_traits t ON t.species_id = s.id
     LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
     LEFT JOIN photos p ON p.id = COALESCE(pick.photo_id, us.cover_photo_id)
     LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
     LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
     WHERE s.id = ANY($4::uuid[])
     ORDER BY s.scientific_name`,
    [userId, [...picks.keys()], [...picks.values()], speciesIds],
  );
  // Centred on the animal when there's no crop, as album covers are.
  const crops = knownDefaultCrops(
    res.rows.filter((r) => r.picked && r.card_crop_x == null).map((r) => r.cover_photo_id!),
  );
  const rows = res.rows.map((row) => {
    const crop = row.picked && row.card_crop_x == null ? crops.get(row.cover_photo_id!) : undefined;
    return crop ? { ...row, card_crop_x: crop.x, card_crop_y: crop.y, card_crop_size: crop.size } : row;
  });
  return markNameChanged(
    userId,
    rows.map((row) => toCollectionItem(row)),
  );
}
