import path from "node:path";
import { TAXON_CLASS_LABEL, otherTaxaGroupLabel, type TaxonClass } from "@lifer/shared";
import { sanitizeForFilesystem } from "./speciesFolderName.js";

// Other Taxa species store iNat's lowercased iconic taxon ("insecta") in taxon_class, which
// TAXON_CLASS_LABEL doesn't know. inatIconicTaxon ("Insecta") gives otherTaxaGroupLabel the Latin
// and English forms, chosen by species_naming_styles; without it, taxon_class is title-cased.
function taxonLabel(taxonClass: string | null, inatIconicTaxon: string | null, namingStyles: string[]): string {
  if (!taxonClass) return "Other";
  const known = TAXON_CLASS_LABEL[taxonClass as TaxonClass];
  if (known) return known;
  if (inatIconicTaxon) return otherTaxaGroupLabel(inatIconicTaxon, namingStyles);
  return taxonClass.charAt(0).toUpperCase() + taxonClass.slice(1);
}

// <location>/<Wildlife year>/<taxon>/<species>/<subfolder>. The year and location (the place
// name typed at import) layers are opt-in.
export function originalsFolder(
  baseDir: string,
  opts: {
    organizeByYear: boolean;
    // Optional: callers without a location leave the path without that layer.
    organizeByLocation?: boolean;
    locationLabel?: string | null;
    speciesFolderName: string;
    taxonClass: string | null;
    // Other Taxa only; see taxonLabel.
    inatIconicTaxon?: string | null;
    namingStyles?: string[];
    takenAt: Date | null;
    /** The camera's wall-clock capture time (exif.ts's CaptureTime.wallClock), when known: the
     *  year folder goes by it, so it's the same whatever zone the server runs in. */
    takenAtWallClock?: string | null;
    subfolder: "RAW" | "Adjusted" | "Video";
  },
): string {
  const root =
    opts.organizeByLocation && opts.locationLabel
      ? path.join(baseDir, sanitizeForFilesystem(opts.locationLabel))
      : baseDir;
  // Stryker disable next-line ArrayDeclaration: equivalent, an unknown style in the list falls back to the same English name as none
  const taxon = taxonLabel(opts.taxonClass, opts.inatIconicTaxon ?? null, opts.namingStyles ?? []);
  if (!opts.organizeByYear) {
    return path.join(root, taxon, opts.speciesFolderName, opts.subfolder);
  }
  const year = opts.takenAtWallClock
    ? opts.takenAtWallClock.slice(0, 4)
    : opts.takenAt
      ? String(opts.takenAt.getFullYear())
      : "Undated";
  return path.join(root, `Wildlife ${year}`, taxon, opts.speciesFolderName, opts.subfolder);
}
