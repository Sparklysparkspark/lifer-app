import { TAXON_CLASS_LABEL, otherTaxaGroupLabel } from "@lifer/shared";

// A taxon filter value: one of the fixed taxon classes, "other-taxa", or a specific Other Taxa
// iconic group (e.g. "insecta"), which Other Taxa species store directly in taxon_class.
export type TaxonFilter = string;

export const TAXON_LABEL: Record<string, string> = {
  all: "All taxa",
  ...TAXON_CLASS_LABEL,
  "other-taxa": "Other Taxa",
};

// An Other Taxa iconic group is its lowercased iNat name; otherTaxaGroupLabel needs the real
// casing ("Insecta") both to look up the English label and as the Latin text itself.
export function taxonFilterLabel(t: string, namingStyles: string[]): string {
  if (t in TAXON_LABEL) return TAXON_LABEL[t];
  return otherTaxaGroupLabel(t.charAt(0).toUpperCase() + t.slice(1), namingStyles);
}

export function isOtherTaxaFilter(t: string): boolean {
  return t === "other-taxa" || !(t in TAXON_LABEL);
}
