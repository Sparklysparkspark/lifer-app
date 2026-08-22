import path from "node:path";

// Matches CollectionPage.tsx's TAXON_LABEL — kept in sync by hand since one's frontend
// display copy and the other's a filesystem folder name, not worth sharing a module for.
const TAXON_LABEL: Record<string, string> = {
  aves: "Birds",
  mammalia: "Mammals",
  actinopterygii: "Fish",
};

function taxonLabel(taxonClass: string | null): string {
  return (taxonClass && TAXON_LABEL[taxonClass]) || "Other";
}

// An opt-in alternate originals layout, grouping photos by year (handy for importing into
// external libraries like Immich). Species still only ever needs its own folder name; the
// year layer above it comes from taken_at, so one species' photos across years land in
// different `Wildlife <year>` roots, and this fn is the one place that split happens (see
// organize_originals_by_year on users, toggled from Settings).
export function originalsFolder(
  baseDir: string,
  opts: {
    organizeByYear: boolean;
    speciesFolderName: string;
    taxonClass: string | null;
    takenAt: Date | null;
    subfolder: "RAW" | "Adjusted";
  },
): string {
  if (!opts.organizeByYear) {
    return path.join(baseDir, opts.speciesFolderName, opts.subfolder);
  }
  const year = opts.takenAt ? String(opts.takenAt.getFullYear()) : "Undated";
  return path.join(baseDir, `Wildlife ${year}`, taxonLabel(opts.taxonClass), opts.speciesFolderName, opts.subfolder);
}
