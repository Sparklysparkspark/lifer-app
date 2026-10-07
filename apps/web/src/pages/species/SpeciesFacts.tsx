import SeasonalityBar from "../../components/SeasonalityBar";
import WeeklyBar from "../../components/WeeklyBar";
import SpeciesHotspotMap from "../../components/SpeciesHotspotMap";
import { buildInaturalistObservationsUrl } from "../../lib/inaturalist";
import { formatDate } from "../../lib/format";
import { pluralWord } from "../../lib/pluralize";
import { iucnBadge, iucnStatValue, type IucnTone } from "../../lib/iucnDisplay";
import type { EncountersResponse, SpeciesDetail } from "./types";

const BADGE = "inline-block rounded-full px-2 py-0.5 text-xs uppercase tracking-wide";

export function SpeciesBadges({ detail }: { detail: SpeciesDetail }) {
  const { species } = detail;
  // Conservation status beside the tier, never folded into it: how hard a species is to find and
  // how threatened it is often differ (an endangered wader can be on every mudflat). Not Evaluated
  // shows too, quietly: a blank would read as a gap in Lifer's data, not as IUCN never having
  // assessed it (most nudibranchs, sponges and sea stars).
  const iucn = iucnBadge(species.iucn_status, species.iucn_note);
  if (
    !species.tier &&
    !iucn &&
    !detail.localTier &&
    !detail.endemicCountryName &&
    !detail.isVagrant &&
    !detail.isInvasive
  ) {
    return null;
  }
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {species.tier && (
        <span
          className={
            species.tier === "unrated"
              ? `${BADGE} border border-dashed border-line text-muted`
              : `${BADGE} bg-surface-muted text-muted`
          }
          title={species.tier === "unrated" ? "Not enough data yet to rate how hard this is to find" : undefined}
        >
          {species.tier === "unrated" ? "Unrated" : species.tier}
        </span>
      )}
      {iucn && (
        <span className={`${BADGE} ${IUCN_TONE_CLASS[iucn.tone]}`} title={iucn.title}>
          {iucn.label}
        </span>
      )}
      {detail.localTier && (
        <span
          className={`${BADGE} border border-line text-muted`}
          title="How rare and hard to find this species is in this region specifically"
        >
          {detail.localTier} here
        </span>
      )}
      {detail.endemicCountryName && (
        <span
          className={`${BADGE} bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300`}
          title="Only ever recorded (real GBIF presence) in this one country"
        >
          Endemic to {detail.endemicCountryName}
        </span>
      )}
      {detail.isVagrant && (
        <span
          className={`${BADGE} bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300`}
          title="Records here are concentrated in very few years, likely a vagrant, not an established local presence"
        >
          Vagrant here
        </span>
      )}
      {detail.isInvasive && (
        <span
          className={`${BADGE} bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300`}
          title="An established population here, but not native: brought in by people (iNaturalist establishment status)"
        >
          Introduced here
        </span>
      )}
    </div>
  );
}

function Count({ n, singular, plural }: { n: number; singular: string; plural?: string }) {
  return (
    <span>
      <span className="font-medium text-ink">{n.toLocaleString()}</span> {pluralWord(n, singular, plural)}
    </span>
  );
}

// A burst of 400 photos from one sighting is one encounter, not 400.
export function EncounterSummary({ encounters }: { encounters: EncountersResponse | null }) {
  if (!encounters || (encounters.totalPhotos === 0 && encounters.videoCount === 0)) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {encounters.totalPhotos > 0 && <Count n={encounters.totalPhotos} singular="photo" />}
      {encounters.videoCount > 0 && <Count n={encounters.videoCount} singular="video" />}
      <Count n={encounters.encounterCount} singular="encounter" />
      {encounters.locationCount > 0 && <Count n={encounters.locationCount} singular="location" />}
      {encounters.cameraCount > 0 && <Count n={encounters.cameraCount} singular="camera" />}
      {encounters.lensCount > 0 && <Count n={encounters.lensCount} singular="lens" plural="lenses" />}
      {encounters.firstPhotographedAt && <span>First: {formatDate(encounters.firstPhotographedAt)}</span>}
    </div>
  );
}

export function SpeciesAbout({ detail }: { detail: SpeciesDetail }) {
  const { species } = detail;
  const inaturalistUrl =
    detail.hotspotDistribution === "widespread"
      ? buildInaturalistObservationsUrl(detail.regionBoundaryGeoJson, species.scientific_name)
      : null;
  return (
    <>
      <SeasonalityBar seasonality={detail.seasonality} />
      <WeeklyBar weeklyFrequency={detail.weeklyFrequency} regionName={detail.weeklyRegionName} />
      {detail.hotspots.length > 0 && (
        <div>
          {detail.hotspotDistribution === "widespread" ? (
            <>
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Where to find it</p>
              <p className="text-sm text-ink">
                Recorded broadly across this region rather than a few specific spots. Keep an eye out anywhere you go,
                not just at particular locations.
              </p>
              {inaturalistUrl && (
                <a
                  href={inaturalistUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-xs text-accent hover:underline"
                >
                  See recent sightings on iNaturalist ↗
                </a>
              )}
            </>
          ) : (
            <SpeciesHotspotMap
              boundaryGeoJson={detail.regionBoundaryGeoJson}
              hotspots={detail.hotspots}
              scientificName={species.scientific_name}
            />
          )}
        </div>
      )}
      {species.description && (
        <p className="text-sm text-ink">
          {species.description}{" "}
          {species.description_source_url && (
            <a
              href={species.description_source_url}
              target="_blank"
              rel="noreferrer"
              className="text-muted hover:underline"
            >
              (Wikipedia)
            </a>
          )}
        </p>
      )}
      {species.habitat_description && (
        <p className="text-sm text-ink">
          <span className="font-medium text-muted">Habitat: </span>
          {species.habitat_description}
        </p>
      )}

      <SpeciesStats species={species} />

      <div className="flex flex-wrap gap-4 text-sm">
        {species.inat_taxon_id && (
          <a
            href={`https://www.inaturalist.org/taxa/${species.inat_taxon_id}`}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:underline"
          >
            View on iNaturalist ↗
          </a>
        )}
        {species.ebird_code && (
          <a
            href={`https://ebird.org/species/${species.ebird_code}`}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:underline"
          >
            View on eBird ↗
          </a>
        )}
      </div>
    </>
  );
}

// Each taxon shows only the traits it has a real source for (AVONET for birds, etc.).
function SpeciesStats({ species }: { species: SpeciesDetail["species"] }) {
  return (
    <dl className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface p-4 text-sm sm:grid-cols-4">
      {species.is_other_taxa && (
        <>
          <Stat label="Family" value={species.family} />
          <Stat label="Order" value={species.taxon_order} />
          <Stat label="Genus" value={species.genus} />
        </>
      )}
      {species.taxon_class === "aves" && (
        <>
          <Stat label="Mass" value={species.mass_g ? formatMass(Number(species.mass_g)) : null} />
          <Stat label="Wingspan" value={species.wingspan_mm ? `${Math.round(Number(species.wingspan_mm))} mm` : null} />
          <Stat label="Niche" value={species.trophic_niche} />
        </>
      )}
      {species.taxon_class === "mammalia" && (
        <>
          <Stat label="Mass" value={species.mass_g ? formatMass(Number(species.mass_g)) : null} />
          <Stat
            label="Home range"
            value={species.home_range_km2 ? `${Math.round(Number(species.home_range_km2))} km²` : null}
          />
          <Stat label="Nocturnal" value={species.nocturnal == null ? null : species.nocturnal ? "Yes" : "No"} />
          {species.domestic && <Stat label="Domestic" value="Yes" />}
        </>
      )}
      {species.taxon_class === "actinopterygii" && (
        <Stat
          label="Depth range"
          value={
            species.depth_min_m != null && species.depth_max_m != null
              ? `${Math.round(Number(species.depth_min_m))}-${Math.round(Number(species.depth_max_m))} m`
              : null
          }
        />
      )}
      <Stat label="IUCN" value={iucnStatValue(species.iucn_status)} />
    </dl>
  );
}

/** Muted for Least Concern and Data Deficient, amber for Near Threatened, red from Vulnerable up,
 *  dashed and quiet for Not Evaluated (like the Unrated tier). */
const IUCN_TONE_CLASS: Record<IucnTone, string> = {
  threatened: "bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  near: "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  neutral: "bg-surface-muted text-muted",
  unassessed: "border border-dashed border-line text-muted",
};

// Grams are stored for every taxon; display picks g / kg / t.
function formatMass(massG: number): string {
  if (massG >= 1_000_000) return `${(massG / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} t`;
  if (massG >= 1_000) return `${(massG / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kg`;
  return `${Math.round(massG)} g`;
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={value ? "text-ink" : "text-muted"}>{value ?? "n/a"}</dd>
    </div>
  );
}
