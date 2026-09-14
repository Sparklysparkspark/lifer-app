import path from "node:path";
import { TAXON_CLASS_LABEL, otherTaxaGroupLabel, type TaxonClass } from "@lifer/shared";
import { sanitizeForFilesystem } from "./speciesFolderName.js";

// Other Taxa species (Settings > Species & Import's any-taxa search) store iNat's own
// lowercased iconic taxon name in taxon_class (e.g. "insecta") — never one of the 18 real
// TaxonClass values, so it always misses TAXON_CLASS_LABEL. inatIconicTaxon carries the SAME
// value in iNat's own real casing ("Insecta"), needed both as the Latin form itself and to look
// up its English label — otherTaxaGroupLabel picks between them (or combines both, "Birds -
// Aves" style) per the user's species_naming_styles preference, the same setting that already
// governs species folder/EXIF naming (a group label has the same Latin-vs-common question a
// species name does). Falls back to title-casing the raw taxon_class only if inatIconicTaxon
// wasn't provided at all (older call sites that don't have it in scope yet).
function taxonLabel(taxonClass: string | null, inatIconicTaxon: string | null, namingStyles: string[]): string {
  if (!taxonClass) return "Other";
  const known = TAXON_CLASS_LABEL[taxonClass as TaxonClass];
  if (known) return known;
  if (inatIconicTaxon) return otherTaxaGroupLabel(inatIconicTaxon, namingStyles);
  return taxonClass.charAt(0).toUpperCase() + taxonClass.slice(1);
}

// Every layout groups by taxon (Birds/Mammals/Fish/Other) — mirrors how the rest of the app
// already organizes browsing, and keeps a growing library navigable outside Lifer too (Finder,
// an external tool like Immich). The year layer is opt-in on top of that (see
// organize_originals_by_year on users, toggled from Settings): species still only ever needs
// its own folder name, and the year comes from taken_at, so one species' photos across years
// land in different `Wildlife <year>` roots — this fn is the one place that split happens.
//
// Location is a second, independent opt-in layer (organize_originals_by_location, migration
// 093) sitting OUTERMOST — a free-text place name the user typed at import time (e.g. "Prince
// George"), not derived from GPS coordinates. Real user workflows described a whole import
// session sharing one location, so it groups everything from that session together above the
// year/taxon split, matching how people already described organizing "by outing" on disk.
// Off (the common case, and the only option before this) or simply not provided for a given
// upload leaves the path exactly as it always was.
export function originalsFolder(
  baseDir: string,
  opts: {
    organizeByYear: boolean;
    // Optional — most call sites (reassignment moves, trip imports, RAW-derivative writes)
    // don't have a per-request location to offer yet; omitting both is identical to today's
    // pre-location behavior.
    organizeByLocation?: boolean;
    locationLabel?: string | null;
    speciesFolderName: string;
    taxonClass: string | null;
    // Optional — only meaningful (and only available) for Other Taxa species; omitting it just
    // falls back to title-casing taxon_class itself instead of a real Latin/common label.
    inatIconicTaxon?: string | null;
    namingStyles?: string[];
    takenAt: Date | null;
    subfolder: "RAW" | "Adjusted" | "Video";
  },
): string {
  const root =
    opts.organizeByLocation && opts.locationLabel ? path.join(baseDir, sanitizeForFilesystem(opts.locationLabel)) : baseDir;
  const taxon = taxonLabel(opts.taxonClass, opts.inatIconicTaxon ?? null, opts.namingStyles ?? []);
  if (!opts.organizeByYear) {
    return path.join(root, taxon, opts.speciesFolderName, opts.subfolder);
  }
  const year = opts.takenAt ? String(opts.takenAt.getFullYear()) : "Undated";
  return path.join(root, `Wildlife ${year}`, taxon, opts.speciesFolderName, opts.subfolder);
}
