// Pulls what offline search reads beyond the photos' own fields: the region tree, and the order,
// family, aliases and codes of the species photographed (GET /sync/search-vocab).
import type { Db } from "../store/db";
import type { SyncApi } from "./engine";
import { inBatches } from "./yield";

interface Vocab {
  regions?: { id: string; name: string; parentId: string | null }[];
  species?: {
    scientificName: string;
    taxonOrder: string | null;
    family: string | null;
    aliases: string[];
    codes: string[];
  }[];
}

export async function pullSearchVocab(d: { db: Db; api: SyncApi }): Promise<void> {
  const v = await d.api.get<Vocab>("/sync/search-vocab", 60_000);
  const regions = v.regions ?? [];
  const species = v.species ?? [];
  await d.db.tx(async () => {
    await d.db.run("DELETE FROM search_regions");
    await d.db.run("DELETE FROM species_names");
  });
  await inBatches(regions, 200, (batch) =>
    d.db.tx(async () => {
      for (const r of batch)
        await d.db.run("INSERT OR REPLACE INTO search_regions (id, name, parent_id) VALUES (?, ?, ?)", [
          r.id,
          r.name,
          r.parentId,
        ]);
    }),
  );
  await inBatches(species, 200, (batch) =>
    d.db.tx(async () => {
      for (const s of batch) {
        await d.db.run("INSERT OR REPLACE INTO species_names (scientific_name, aliases, codes) VALUES (?, ?, ?)", [
          s.scientificName,
          JSON.stringify(s.aliases),
          JSON.stringify(s.codes),
        ]);
        await d.db.run(
          "UPDATE species SET taxon_order = COALESCE(?, taxon_order), family = COALESCE(?, family) WHERE scientific_name = ?",
          [s.taxonOrder, s.family, s.scientificName],
        );
      }
    }),
  );
}
