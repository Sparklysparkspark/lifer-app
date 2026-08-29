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

// Every layout groups by taxon (Birds/Mammals/Fish/Other) — mirrors how the rest of the app
// already organizes browsing, and keeps a growing library navigable outside Lifer too (Finder,
// an external tool like Immich). The year layer is opt-in on top of that (see
// organize_originals_by_year on users, toggled from Settings): species still only ever needs
// its own folder name, and the year comes from taken_at, so one species' photos across years
// land in different `Wildlife <year>` roots — this fn is the one place that split happens.
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
    return path.join(baseDir, taxonLabel(opts.taxonClass), opts.speciesFolderName, opts.subfolder);
  }
  const year = opts.takenAt ? String(opts.takenAt.getFullYear()) : "Undated";
  return path.join(baseDir, `Wildlife ${year}`, taxonLabel(opts.taxonClass), opts.speciesFolderName, opts.subfolder);
}
