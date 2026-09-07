// The human-browsable folder a species' originals live in. commonName has no DB-level
// uniqueness constraint, so two species can genuinely share one (regional/taxonomic overlap
// in source data) — when that happens, EVERY species sharing that common name gets suffixed
// with its scientific name, not just whichever one collided second, so the resulting folder
// name is the same no matter which species is uploaded/rescanned first. Without this, two
// species' photos (and, worse, a future library reimport reading them back) could silently
// land in — or be read from — the same folder.
import { pool } from "../db.js";

export function sanitizeForFilesystem(name: string): string {
  // Slashes would create unintended subfolders; the rest are characters Windows/macOS/Linux
  // either forbid outright or that just make a folder name awkward to look at/type.
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

// Shared by the folder-name and EXIF resolvers: common name is always the base, and any
// selected code(s) get appended alongside it rather than replacing it — a code the species
// doesn't actually have (most non-North-American birds for aba_code; any non-bird, or a bird
// eBird's own taxonomy doesn't cover, for ebird_code) is silently skipped, not substituted with
// something else, since the setting is a global preference, not a guarantee every species can
// honor every part of it.
// `transform` runs on the base name and each code individually, BEFORE joining them together —
// resolveSpeciesFolderName passes sanitizeForFilesystem here so a folder-forbidden character in
// one part can't eat the " / " separator between parts (sanitizing the whole joined string
// afterward would strip the slash itself, since it's one of the forbidden characters). The EXIF
// label has no such constraint, so writeSpeciesMetadata leaves this at the identity default.
export function composeSpeciesName(
  commonName: string | null,
  scientificName: string,
  namingStyles: string[],
  codes: { abaCode: string | null; ebirdCode: string | null },
  transform: (part: string) => string = (part) => part,
): string {
  const base = transform(commonName ?? scientificName);
  const parts = namingStyles
    .map((style) => (style === "aba_code" ? codes.abaCode : style === "ebird_code" ? codes.ebirdCode : null))
    .filter((code): code is string => !!code)
    .map(transform);
  if (parts.length === 0) return base;
  return `${base} (${parts.join(" / ")})`;
}

// speciesId + userId, not raw name strings — species_naming_styles (migration 082) is a
// per-user preference, and ABA/eBird codes live on the species row itself, so this needs a
// fresh lookup rather than trusting whatever name string a caller already had in hand (which
// predates this setting existing and would always resolve to the common-name behavior).
export async function resolveSpeciesFolderName(userId: string, speciesId: string): Promise<string> {
  const res = await pool.query<{
    common_name: string | null;
    scientific_name: string;
    aba_code: string | null;
    ebird_code: string | null;
    species_naming_styles: string[];
  }>(
    `SELECT s.common_name, s.scientific_name, s.aba_code, s.ebird_code,
            (SELECT species_naming_styles FROM users WHERE id = $1) AS species_naming_styles
       FROM species s WHERE s.id = $2`,
    [userId, speciesId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`resolveSpeciesFolderName: no species found for id ${speciesId}`);

  const commonName = row.common_name;
  const scientificName = row.scientific_name;
  const codes = { abaCode: row.aba_code, ebirdCode: row.ebird_code };
  const styles = row.species_naming_styles ?? [];
  const composed = composeSpeciesName(commonName, scientificName, styles, codes);
  const base = composeSpeciesName(commonName, scientificName, styles, codes, sanitizeForFilesystem);
  if (!commonName) return base;
  // The common-name collision suffix only matters when the folder name is otherwise just the
  // common name — once a code is appended it's already unique to this species, so two species
  // sharing a common name can't collide.
  if (composed !== commonName) return base;
  const collision = await pool.query(`SELECT 1 FROM species WHERE common_name = $1 AND scientific_name != $2 LIMIT 1`, [
    commonName,
    scientificName,
  ]);
  if (collision.rows.length === 0) return base;
  return `${base} (${scientificName})`;
}
