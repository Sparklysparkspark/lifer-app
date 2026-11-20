// A small library with real species names for the search golden queries, written straight to the
// test database on top of the sparse seed's account and regions (support/extremeLibrary.ts).
// Species and captures use fixed ids, and the extreme seed's own reset removes them.
import type { ClientBase } from "pg";
import { assertTestDatabase, seedSparse, writeSharedImages } from "./extremeLibrary.js";

export interface GoldenSpecies {
  common: string;
  scientific: string;
  taxonClass: "aves" | "mammalia" | "amphibia";
  order: string;
  family: string;
  tier: "common" | "occasional" | "uncommon" | "rare" | "legendary";
  /** eBird and ABA codes, for the species a code search finds. */
  codes?: { ebird: string; aba: string };
  /** Empty for a species in the catalog and on the checklist that was never photographed. */
  photos: Array<{ taken: string; camera: string; place: string; count: number }>;
}

const S = (
  common: string,
  scientific: string,
  taxonClass: GoldenSpecies["taxonClass"],
  order: string,
  family: string,
  tier: GoldenSpecies["tier"],
  photos: GoldenSpecies["photos"],
  codes?: GoldenSpecies["codes"],
): GoldenSpecies => ({ common, scientific, taxonClass, order, family, tier, photos, codes });

const R5 = "Canon EOS R5";
const A1 = "Sony ILCE-1";
const P = (taken: string, camera: string, place: string, count = 1) => ({ taken, camera, place, count });

export const GOLDEN_SPECIES: GoldenSpecies[] = [
  S(
    "Pileated Woodpecker",
    "Dryocopus pileatus",
    "aves",
    "Piciformes",
    "Picidae",
    "uncommon",
    [
      P("2023-05-14 08:30", R5, "Stanley Park"),
      P("2024-06-02 09:10", R5, "Stanley Park"),
      P("2021-03-09 15:00", A1, "Burnaby Lake"),
    ],
    { ebird: "pilwoo", aba: "PIWO" },
  ),
  S("Red Fox", "Vulpes vulpes", "mammalia", "Carnivora", "Canidae", "common", [
    P("2022-01-10 16:45", A1, "Lighthouse Park"),
    P("2022-01-11 07:20", A1, "Lighthouse Park", 2),
  ]),
  S("Arctic Fox", "Vulpes lagopus", "mammalia", "Carnivora", "Canidae", "rare", [
    P("2022-02-02 11:00", A1, "Churchill"),
  ]),
  S("American Crow", "Corvus brachyrhynchos", "aves", "Passeriformes", "Corvidae", "common", [
    P("2023-08-20 18:00", R5, "Stanley Park", 3),
    P("2019-11-05 10:00", R5, "Burnaby Lake"),
  ]),
  S("Moose", "Alces alces", "mammalia", "Artiodactyla", "Cervidae", "uncommon", [
    P("2022-09-18 06:45", R5, "Algonquin"),
    P("2024-09-10 19:00", R5, "Algonquin"),
  ]),
  S("Common Moorhen", "Gallinula chloropus", "aves", "Gruiformes", "Rallidae", "occasional", [
    P("2020-07-04 13:00", A1, "Burnaby Lake"),
  ]),
  S("Purple Finch", "Haemorhous purpureus", "aves", "Passeriformes", "Fringillidae", "common", [
    P("2023-04-02 09:00", R5, "Stanley Park"),
  ]),
  S("Purple Martin", "Progne subis", "aves", "Passeriformes", "Hirundinidae", "occasional", [
    P("2023-06-15 17:30", R5, "Burnaby Lake"),
  ]),
  S("Purple Sandpiper", "Calidris maritima", "aves", "Charadriiformes", "Scolopacidae", "rare", [
    P("2021-12-01 12:00", A1, "Churchill"),
  ]),
  S("Black-capped Chickadee", "Poecile atricapillus", "aves", "Passeriformes", "Paridae", "common", [
    P("2021-02-03 12:00", R5, "Stanley Park"),
    P("2024-01-20 12:00", R5, "Stanley Park"),
  ]),
  S("Great Horned Owl", "Bubo virginianus", "aves", "Strigiformes", "Strigidae", "rare", [
    P("2022-11-12 21:00", A1, "Algonquin"),
  ]),
  S("Bald Eagle", "Haliaeetus leucocephalus", "aves", "Accipitriformes", "Accipitridae", "legendary", [
    P("2020-03-15 10:30", A1, "Churchill"),
  ]),
  // Catalog only: naming an animal nobody photographed ("tiger") must find no photos.
  S("Tiger Salamander", "Ambystoma tigrinum", "amphibia", "Caudata", "Ambystomatidae", "occasional", []),
];

const GBIF_BASE = 970_000_000;
const id = (kind: number, index: number) =>
  `e0000000-${String(kind).padStart(4, "0")}-4000-8000-${index.toString(16).padStart(12, "0")}`;
const USER_ID = "e0000000-0001-4000-8000-000000000000";
const REGION_STATE = id(3, 10);
const REGION_COUNTRY = id(3, 2);

/** The golden library: the sparse account with no items, plus GOLDEN_SPECIES and their photos. */
export async function seedSearchGolden(db: ClientBase): Promise<void> {
  const files = await writeSharedImages();
  await seedSparse(db, { items: 0 });
  await assertTestDatabase(db);
  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count) VALUES ('extreme-xsa-all', 'Extreme States of America', NULL, $1)`,
      [GOLDEN_SPECIES.length],
    );
    await db.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [REGION_COUNTRY]);
    let n = 0;
    for (const [i, s] of GOLDEN_SPECIES.entries()) {
      const sid = id(2, i);
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, family, taxon_order, sort_order, ebird_code, aba_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          sid,
          GBIF_BASE + i + 1,
          s.scientific,
          s.common,
          s.taxonClass,
          s.family,
          s.order,
          i + 1,
          s.codes?.ebird ?? null,
          s.codes?.aba ?? null,
        ],
      );
      await db.query(`INSERT INTO species_rarity (species_id, tier) VALUES ($1, $2)`, [sid, s.tier]);
      await db.query(
        `INSERT INTO pack_species (pack_id, species_id, provided_enrichment) VALUES ('extreme-xsa-all', $1, true)`,
        [sid],
      );
      await db.query(
        `INSERT INTO region_species (region_id, species_id, local_tier, local_frequency) VALUES ($1, $2, $3, 0.5), ($4, $2, $3, 0.5)`,
        [REGION_COUNTRY, sid, s.tier, REGION_STATE],
      );
      const takes = [...s.photos].sort((a, b) => a.taken.localeCompare(b.taken));
      for (const p of takes) {
        const cid = id(5, n);
        const pid = id(6, n);
        await db.query(
          `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, camera_model, region_id, location_label, subject_count)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9)`,
          [cid, USER_ID, sid, `golden-${n}`, `${p.taken}+00`, p.camera, REGION_STATE, p.place, p.count],
        );
        await db.query(
          `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height, kind) VALUES ($1, $2, $3, $4, 480, 320, 'image')`,
          [pid, cid, files.display, files.thumb],
        );
        await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [pid, cid]);
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id, species_id)
           VALUES ($1, 'jpeg', 'path', $2, false, $3, 4096, $4, $5)`,
          [cid, files.original, `golden-${n}`, USER_ID, sid],
        );
        n++;
      }
      if (takes.length > 0) {
        const first = takes[0];
        await db.query(
          `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, best_quality)
           VALUES ($1, $2, 'collected', $3, $4::date, 3)`,
          [USER_ID, sid, id(6, n - takes.length), first.taken.slice(0, 10)],
        );
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
