// Response schemas for the stats routes (GET /stats and stats/insights.ts). They document the
// answer in the OpenAPI document; fields not listed still pass through.
import { Type } from "typebox";
import { DateTime, Nullable, Open, Uuid } from "../lib/schema.js";

const Count = Type.Integer();

const SpeciesRef = Open({ speciesId: Uuid(), scientificName: Type.String(), commonName: Nullable(Type.String()) });
const GearUse = { photoCount: Count, speciesCount: Count };
const ExifBucket = Open({
  label: Type.String(),
  count: Count,
  photoIds: Type.Array(Uuid(), { description: "A sample of up to 300 photos in this bucket" }),
});

export const StatsOverview = Open({
  totalKeepers: Count,
  insights: Type.Array(Type.String()),
  ghostSpecies: Type.Array(SpeciesRef),
  lostSpecies: Type.Array(SpeciesRef),
  rediscoveredSpecies: Type.Array(SpeciesRef),
  perMonth: Type.Array(
    Open({ month: Type.String({ description: "YYYY-MM" }), label: Type.String(), newLifers: Count, keepers: Count }),
  ),
  gearUsage: Open({
    cameras: Type.Array(Open({ model: Type.String(), ...GearUse })),
    lenses: Type.Array(Open({ model: Type.String(), ...GearUse })),
    combos: Type.Array(Open({ camera: Type.String(), lens: Type.String(), ...GearUse })),
  }),
  timeOfDay: Type.Array(Open({ hour: Count, label: Type.String(), count: Count })),
  exifDistributions: Open({
    focalLength: Type.Array(ExifBucket),
    iso: Type.Array(ExifBucket),
    aperture: Type.Array(ExifBucket),
    shutter: Type.Array(ExifBucket),
  }),
  hitRateByFocalLength: Type.Array(Open({ label: Type.String(), species: Count })),
  scatter: Type.Array(
    Open({
      focalLength: Nullable(Type.Number()),
      aperture: Nullable(Type.Number()),
      iso: Nullable(Count),
      shutterSeconds: Nullable(Type.Number()),
      shutterLabel: Nullable(Type.String()),
      scientificName: Type.String(),
      commonName: Nullable(Type.String()),
      photoId: Nullable(Uuid()),
      camera: Nullable(Type.String()),
      lens: Nullable(Type.String()),
      takenAt: Nullable(DateTime()),
    }),
  ),
  countriesPhotographed: Open({
    count: Count,
    countries: Type.Array(Open({ name: Type.String(), photoCount: Count })),
  }),
});

export const SpeciesPortfolio = Open({
  species: Type.Array(
    Open({
      speciesId: Uuid(),
      commonName: Nullable(Type.String()),
      scientificName: Type.String(),
      taxonClass: Type.String(),
      totalPhotos: Count,
      rated4Plus: Count,
      bestRating: Nullable(Count),
      earliestTakenAt: Nullable(Type.String()),
      latestTakenAt: Nullable(Type.String()),
    }),
  ),
});

export const ArchiveHealth = Open({ total: Count, missingDate: Count });

const TaxonShare = Open({ taxonClass: Type.String(), count: Count, percent: Type.Number() });

export const GearSpeciesBreakdown = Open({ breakdown: Type.Array(TaxonShare) });

const YearStats = Open({
  year: Count,
  speciesCount: Count,
  photoCount: Count,
  avgFocalLength: Nullable(Count),
  avgIso: Nullable(Count),
});
export const YearComparison = Open({ a: YearStats, b: YearStats });

export const PhotographyDna = Open({
  taxonBreakdown: Type.Array(TaxonShare),
  categoryBreakdown: Type.Array(Open({ key: Type.String(), count: Count, percent: Type.Number() })),
  medianFocalLengthMm: Nullable(Type.Number()),
  medianShutterSeconds: Nullable(Type.Number()),
  medianIso: Nullable(Type.Number()),
});
