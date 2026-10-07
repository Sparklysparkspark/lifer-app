// GET /api/stats?filter=
export interface StatsResponse {
  totalKeepers: number;
  insights: string[];
  perMonth: Array<{ month: string; label: string; newLifers: number; keepers: number }>;
  gearUsage: {
    cameras: Array<{ model: string; photoCount: number; speciesCount: number }>;
    lenses: Array<{ model: string; photoCount: number; speciesCount: number }>;
    combos: Array<{ camera: string; lens: string; photoCount: number; speciesCount: number }>;
  };
  timeOfDay: Array<{ hour: number; label: string; count: number }>;
  exifDistributions: {
    focalLength: ExifBucket[];
    iso: ExifBucket[];
    aperture: ExifBucket[];
    shutter: ExifBucket[];
  };
  hitRateByFocalLength: Array<{ label: string; species: number }>;
  scatter: ScatterPoint[];
  countriesPhotographed: { count: number; countries: Array<{ name: string; photoCount: number }> };
  ghostSpecies: SpeciesRef[];
  lostSpecies: SpeciesRef[];
  rediscoveredSpecies: SpeciesRef[];
}

export interface ExifBucket {
  label: string;
  count: number;
  photoIds: string[];
}

export interface ScatterPoint {
  focalLength: number | null;
  aperture: number | null;
  iso: number | null;
  shutterSeconds: number | null;
  shutterLabel: string | null;
  scientificName: string;
  commonName: string | null;
  photoId: string | null;
}

export interface SpeciesRef {
  speciesId: string;
  scientificName: string;
  commonName: string | null;
}

// GET /api/stats/species-portfolio
export interface SpeciesPortfolioResponse {
  species: PortfolioSpecies[];
}

export interface PortfolioSpecies {
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  taxonClass: string;
  totalPhotos: number;
  rated4Plus: number;
  bestRating: number | null;
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
}

// GET /api/stats/archive-health
export interface ArchiveHealthResponse {
  total: number;
  missingDate: number;
}

// GET /api/stats/photography-dna
export interface PhotographyDnaResponse {
  taxonBreakdown: Array<{ taxonClass: string; count: number; percent: number }>;
  categoryBreakdown: Array<{ key: string; count: number; percent: number }>;
  medianFocalLengthMm: number | null;
  medianShutterSeconds: number | null;
  medianIso: number | null;
}

// GET /api/stats/year-comparison
export interface YearComparisonResponse {
  a: YearSummary;
  b: YearSummary;
}

export interface YearSummary {
  year: number;
  speciesCount: number;
  photoCount: number;
  avgFocalLength: number | null;
  avgIso: number | null;
}

export type PhotoFilter = "all" | "featured" | "topRated";
