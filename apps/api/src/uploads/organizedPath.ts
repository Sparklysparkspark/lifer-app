import path from "node:path";
import { TAXON_CLASS_LABEL, otherTaxaGroupLabel, type FolderLevel, type TaxonClass } from "@lifer/shared";
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

const pad = (n: number) => String(n).padStart(2, "0");

// One folder per level of the user's layout (packages/shared/src/folderLayout.ts), outermost
// first, then the RAW/Adjusted/Video folder. A level the photo has no value for is skipped,
// except "Wildlife <year>", which keeps its "Wildlife Undated" folder so existing paths stay put.
// Only managedFolders.ts calls this: everything else files through its speciesFolder, which
// fills the taxon, place and naming options consistently.
export function originalsFolder(
  baseDir: string,
  opts: {
    layout: readonly FolderLevel[];
    speciesFolderName: string;
    taxonClass: string | null;
    taxonOrder?: string | null;
    family?: string | null;
    // Other Taxa only; see taxonLabel.
    inatIconicTaxon?: string | null;
    namingStyles?: string[];
    tripName?: string | null;
    /** The region's country and province names (regions/photoPlace.ts). */
    country?: string | null;
    province?: string | null;
    locationLabel?: string | null;
    takenAt: Date | null;
    /** The camera's wall-clock capture time (exif.ts's CaptureTime.wallClock), when known: the
     *  date folders go by it, so they're the same whatever zone the server runs in. */
    takenAtWallClock?: string | null;
    subfolder: "RAW" | "Adjusted" | "Video" | "Audio";
  },
): string {
  const t = opts.takenAt;
  const day =
    opts.takenAtWallClock?.slice(0, 10) ??
    (t ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` : null);
  const name = (v: string | null | undefined) => (v ? sanitizeForFilesystem(v) : null);
  const folders: Record<FolderLevel, string | null> = {
    wildlifeYear: `Wildlife ${day?.slice(0, 4) ?? "Undated"}`,
    year: day?.slice(0, 4) ?? null,
    month: day?.slice(0, 7) ?? null,
    date: day,
    trip: opts.tripName && name(opts.tripName) ? path.join("Trips", name(opts.tripName)!) : null,
    country: name(opts.country),
    province: name(opts.province),
    place: name(opts.locationLabel),
    // Stryker disable next-line ArrayDeclaration: equivalent, an unknown style in the list falls back to the same English name as none
    group: taxonLabel(opts.taxonClass, opts.inatIconicTaxon ?? null, opts.namingStyles ?? []),
    order: name(opts.taxonOrder),
    family: name(opts.family),
    species: opts.speciesFolderName,
  };
  const parts = opts.layout.map((level) => folders[level]).filter((f): f is string => !!f);
  return path.join(baseDir, ...parts, opts.subfolder);
}
