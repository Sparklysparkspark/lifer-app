// The browsable folder a species' originals live in. Common names aren't unique, so every species
// sharing one gets its scientific name appended, which keeps the name the same whichever is
// imported first and keeps two species out of one folder.
import { pool } from "@lifer/core/db.js";
import { trimEndChars } from "../lib/trimChars.js";

/** Drops characters that would make a subfolder or that some OS forbids in a name, and trims. */
export function stripForbiddenNameChars(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

/** A folder name: also drops trailing dots and spaces, which Windows silently removes, so
 * "Sp." and "Sp" name the same folder everywhere. */
export function sanitizeForFilesystem(name: string): string {
  return trimEndChars(stripForbiddenNameChars(name), ". ");
}

// Shared by the folder-name and EXIF resolvers. The first of the user's species_naming_styles
// parts that exists is the primary name; the rest go in parentheses. Defaults to the common name.
// `transform` runs on each part before joining.
export function composeSpeciesName(
  commonName: string | null,
  scientificName: string,
  namingStyles: string[],
  codes: { abaCode: string | null; ebirdCode: string | null },
  transform: (part: string) => string = (part) => part,
  // Only the "tree" style needs it. Missing ranks are skipped.
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
                ? // Spaced " / ": sanitizeForFilesystem strips a bare "/", which would run the
                  // ranks together. A label, not nested folders.
                  [
                    taxonomy?.taxonClass
                      ? taxonomy.taxonClass.charAt(0).toUpperCase() + taxonomy.taxonClass.slice(1)
                      : null,
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
  return `${primary} (${rest.join(", ")})`;
}

// Looked up by id: the naming style is per user and the codes live on the species row.
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
  // Stryker disable next-line ArrayDeclaration: equivalent, an unknown style is ignored just like an empty list
  const styles = row.species_naming_styles ?? [];
  const composed = composeSpeciesName(commonName, scientificName, styles, codes, (part) => part, taxonomy);
  const base = composeSpeciesName(commonName, scientificName, styles, codes, sanitizeForFilesystem, taxonomy);
  if (!commonName) return base;
  // The collision suffix only matters when the name is just the common name; an appended code
  // already makes it unique.
  if (composed !== commonName) return base;
  // Extinct and fossil species can never be photographed, so they don't count as a name collision.
  const collision = await pool.query(
    `SELECT 1 FROM species s LEFT JOIN species_traits t ON t.species_id = s.id
     WHERE s.common_name = $1 AND s.scientific_name != $2 AND COALESCE(t.fully_extinct, false) = false
     LIMIT 1`,
    [commonName, scientificName],
  );
  if (collision.rows.length === 0) return base;
  return `${base} (${scientificName})`;
}
