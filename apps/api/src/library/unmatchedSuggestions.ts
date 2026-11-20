// A guess at the species of a photo the reimport couldn't match, for the user to confirm: the
// names the photo carries (its species tags, and the species folder it sits in, which is how
// Lifer and most people file photos) looked up on iNaturalist. A name iNaturalist knows exactly,
// as a scientific or common name, is a confident suggestion; otherwise its best match is offered
// as a guess. Only ever a suggestion: nothing is imported until the user confirms it.
import path from "node:path";
// Paced at iNaturalist's one request a second, backed off when it refuses, and cached, so a large
// library takes a while in the background rather than being cut short, and a rerun is free.
import { inatFetch } from "@lifer/core/species/inatClient.js";

const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";

export interface SpeciesSuggestion {
  inatTaxonId: number;
  scientificName: string;
  commonName: string | null;
  /** The photo's own name is exactly this species' scientific or common name. */
  exact: boolean;
}

// Folders that say how a library is laid out, not which species is in them.
const LAYOUT_FOLDERS = new Set(["adjusted", "raw", "originals", "lifer photos", "lifer originals", "photos"]);
const isLayoutFolder = (name: string) => LAYOUT_FOLDERS.has(name.toLowerCase()) || /^\d{4}(-\d{2})?$/.test(name);

/** The names worth looking up for one photo, most telling first: its species tags, then the
 *  nearest folder that isn't layout (Insects/Fuzzy-Horned Bumble Bee/Adjusted/x.jpg gives the
 *  bumble bee, not "Adjusted"). */
export function candidateNames(relativePath: string, keywords: string[]): string[] {
  const names = keywords.map((k) => k.trim()).filter((k) => k.length > 2);
  const folders = path
    .dirname(relativePath)
    .split(/[\\/]/)
    .filter((f) => f && f !== ".")
    .reverse();
  const species = folders.find((f) => !isLayoutFolder(f));
  if (species) names.push(species);
  return [...new Set(names)];
}

interface InatTaxon {
  id: number;
  name: string;
  rank?: string;
  preferred_common_name?: string;
  matched_term?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** The best result for a name: an exact scientific or common name match, else the top species. */
export function pickSuggestion(name: string, results: InatTaxon[]): SpeciesSuggestion | null {
  const species = results.filter((r) => !r.rank || r.rank === "species");
  if (species.length === 0) return null;
  const wanted = norm(name);
  const exact = species.find(
    (r) => norm(r.name) === wanted || (r.preferred_common_name && norm(r.preferred_common_name) === wanted),
  );
  const pick = exact ?? species[0];
  return {
    inatTaxonId: pick.id,
    scientificName: pick.name,
    commonName: pick.preferred_common_name ?? null,
    exact: !!exact,
  };
}

/** Looks a name up on iNaturalist. Null when there's no species for it; throws when offline. */
export async function lookUpName(name: string): Promise<SpeciesSuggestion | null> {
  const res = await inatFetch(`${INAT_TAXA_API}?q=${encodeURIComponent(name)}&rank=species&is_active=true&per_page=5`);
  if (!res.ok) throw new Error(`iNaturalist answered ${res.status}`);
  const body = (await res.json()) as { results?: InatTaxon[] };
  return pickSuggestion(name, body.results ?? []);
}
