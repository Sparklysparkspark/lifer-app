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

// Shared by the folder-name and EXIF resolvers. Four pluggable parts — common name, scientific
// (Latin) name, eBird code, ABA code — in whatever order and combination the user picked
// (species_naming_styles, migration 082/091): the FIRST part that actually resolves for this
// species becomes the unparenthesized primary name, everything after it is appended in parens.
// A part the species doesn't actually have (most non-North-American birds for aba_code; any
// non-bird, or a bird eBird's own taxonomy doesn't cover, for ebird_code; a species genuinely
// missing a common name for "common") is silently skipped, not substituted with something else
// — the setting is a preference, not a guarantee every species can honor every part of it. An
// empty/never-configured setting defaults to common-name-only (this file's original behavior),
// and if every selected part is unavailable for this specific species, falls back the same way.
// `transform` runs on each resolved part individually, BEFORE joining them together —
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
  // Optional — only "tree" actually needs it, and most callers already have common/scientific
  // name + codes in hand without a taxonomy join. Missing/unavailable ranks (most Other Taxa
  // species have no taxon_order on file) are just skipped, same "silently drop what's missing"
  // rule as every other part here — not treated as this species failing to have a tree at all.
  taxonomy?: { taxonClass: string | null; taxonOrder: string | null; family: string | null },
): string {
  const styles = namingStyles.length > 0 ? namingStyles : ["common"];
  const resolved = styles
    .map((style) =>
      style === "common"
        ? commonName
        : style === "latin"
          ? scientificName
          : style === "aba_code"
            ? codes.abaCode
            : style === "ebird_code"
              ? codes.ebirdCode
              : style === "tree"
                ? // " / " (spaced), not a bare "/" — a bare slash is exactly what
                  // sanitizeForFilesystem strips (see this file's own top comment on why: it
                  // would otherwise create unintended real subfolders), which would collapse
                  // this whole rank list back into one run-together word for the folder-name
                  // caller. This is one naming-style LABEL, not a request for genuine nested
                  // class/order/family folders on disk — a real taxonomic folder tree would be
                  // a bigger, separate structural feature, not a naming-style variant.
                  [
                    taxonomy?.taxonClass ? taxonomy.taxonClass.charAt(0).toUpperCase() + taxonomy.taxonClass.slice(1) : null,
                    taxonomy?.taxonOrder,
                    taxonomy?.family,
                    scientificName,
                  ]
                    .filter(Boolean)
                    .join(" / ")
                : null,
    )
    .filter((part): part is string => !!part)
    .map(transform);
  if (resolved.length === 0) return transform(commonName ?? scientificName);
  const [primary, ...rest] = resolved;
  if (rest.length === 0) return primary;
  return `${primary} (${rest.join(" / ")})`;
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
    taxon_class: string | null;
    taxon_order: string | null;
    family: string | null;
    species_naming_styles: string[];
  }>(
    `SELECT s.common_name, s.scientific_name, s.aba_code, s.ebird_code, s.taxon_class, s.taxon_order, s.family,
            (SELECT species_naming_styles FROM users WHERE id = $1) AS species_naming_styles
       FROM species s WHERE s.id = $2`,
    [userId, speciesId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`resolveSpeciesFolderName: no species found for id ${speciesId}`);

  const commonName = row.common_name;
  const scientificName = row.scientific_name;
  const codes = { abaCode: row.aba_code, ebirdCode: row.ebird_code };
  const taxonomy = { taxonClass: row.taxon_class, taxonOrder: row.taxon_order, family: row.family };
  const styles = row.species_naming_styles ?? [];
  const composed = composeSpeciesName(commonName, scientificName, styles, codes, (part) => part, taxonomy);
  const base = composeSpeciesName(commonName, scientificName, styles, codes, sanitizeForFilesystem, taxonomy);
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
