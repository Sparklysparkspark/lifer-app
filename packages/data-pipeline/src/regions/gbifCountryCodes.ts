// Which GBIF country codes a country's download covers. GBIF files a territory's records under
// the territory's own code, so a territory we model as a province (Svalbard under Norway) or as
// part of a Natural Earth country that borrows its sovereign's iso2 (Indian Ocean Ter. is "AU")
// would otherwise get none of its records.

// Territories modelled as provinces of the parent: their codes join the parent's download.
const OVERSEAS_TERRITORY_GBIF_CODES: Record<string, string[]> = {
  FR: ["GP", "GF", "MQ", "RE", "YT"],
  NL: ["BQ"],
  NO: ["SJ", "BV"],
  NZ: ["TK"],
};

// Natural Earth countries that share their sovereign's iso2 but whose land GBIF codes on its
// own: downloaded by those codes instead of the sovereign's whole country.
const OWN_GBIF_CODES_BY_COUNTRY: Record<string, string[]> = {
  "Indian Ocean Ter.": ["CX", "CC"],
};

export interface GbifDownload {
  /** GBIF countrycode values the download selects. */
  codes: string[];
  /** File name (without .zip) in the GBIF country cache. Two letters, so the sea-zone scan reads it too. */
  zipName: string;
}

export function gbifDownloadFor(countryName: string, iso2: string): GbifDownload {
  const own = OWN_GBIF_CODES_BY_COUNTRY[countryName];
  if (own) return { codes: own, zipName: own[0] };
  return { codes: [iso2, ...(OVERSEAS_TERRITORY_GBIF_CODES[iso2] ?? [])], zipName: iso2 };
}

/** The download's `WHERE` filter on GBIF's countrycode column. */
export function countryCodeFilter(codes: string[]): string {
  return codes.length === 1
    ? `countrycode = '${codes[0]}'`
    : `countrycode IN (${codes.map((c) => `'${c}'`).join(", ")})`;
}
