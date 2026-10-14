import SeasonalityBar from "../../components/SeasonalityBar";
import WeeklyBar from "../../components/WeeklyBar";
import SpeciesHotspotMap from "../../components/SpeciesHotspotMap";
import { buildInaturalistObservationsUrl } from "../../lib/inaturalist";
import { formatNumber } from "../../lib/format";
import { pluralWord } from "../../lib/pluralize";
import { iucnBadge, iucnCategoryName, type IucnTone } from "../../lib/iucnDisplay";
import { PANEL } from "../../lib/layout";
import type { EncountersResponse, SpeciesDetail } from "./types";
import { usePersistedState } from "../../hooks/usePersistedState";
import { FactRow, SpeciesNotes } from "./SpeciesNotes";

export function SpeciesStatus({ detail }: { detail: SpeciesDetail }) {
  const { species } = detail;
  // Conservation status beside the tier, never folded into it: how hard a species is to find and
  // how threatened it is often differ (an endangered wader can be on every mudflat). Not Evaluated
  // shows too, quietly: a blank would read as a gap in Lifer's data, not as IUCN never having
  // assessed it (most nudibranchs, sponges and sea stars).
  const iucn = iucnBadge(species.iucn_status, species.iucn_note);
  // Short tags that read on their own; colour only where it warns, details in the tooltips.
  const rows: Array<{ value: string; className?: string; title?: string }> = [];
  if (species.tier)
    rows.push(
      species.tier === "unrated"
        ? { value: "Unrated", className: "text-muted", title: "Not enough data yet to rate how hard this is to find" }
        : { value: capitalize(species.tier), title: "How hard this species is to find and photograph" },
    );
  if (detail.localTier)
    rows.push({
      value: `${capitalize(detail.localTier)} here`,
      title: "How rare and hard to find this species is in this region specifically",
    });
  if (detail.isVagrant)
    rows.push({
      value: "Vagrant here",
      className: "text-sky-700 dark:text-sky-300",
      title: "Records here are concentrated in very few years, likely a vagrant, not an established local presence",
    });
  if (detail.isInvasive)
    rows.push({
      value: "Introduced here",
      className: "text-rose-700 dark:text-rose-300",
      title: "An established population here, but not native: brought in by people (iNaturalist establishment status)",
    });
  if (detail.endemicCountryName)
    rows.push({
      value: `Endemic to ${detail.endemicCountryName}`,
      className: "text-amber-700 dark:text-amber-300",
      title: "Only ever recorded (real GBIF presence) in this one country",
    });
  if (iucn)
    rows.push({
      value: `IUCN ${iucn.code === "NE" ? "Not evaluated" : iucnCategoryName(iucn.code)}`,
      className: IUCN_TONE_CLASS[iucn.tone],
      title: iucn.title,
    });
  if (rows.length === 0) return null;
  return (
    <FactRow
      label="Status"
      items={rows.map((row) => ({ text: row.value, className: row.className, title: row.title }))}
    />
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Count({ n, singular, plural }: { n: number; singular: string; plural?: string }) {
  return (
    <span>
      <span className="font-medium text-ink">{formatNumber(n)}</span> {pluralWord(n, singular, plural)}
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
    </div>
  );
}

/** The overview's side column: when it's seen, your counts, and where. */
function SpeciesSightings({ detail, encounters }: { detail: SpeciesDetail; encounters: EncountersResponse | null }) {
  const { species } = detail;
  const widespread = detail.hotspots.length > 0 && detail.hotspotDistribution === "widespread";
  const clustered = detail.hotspots.length > 0 && !widespread;
  const inaturalistUrl = widespread
    ? buildInaturalistObservationsUrl(detail.regionBoundaryGeoJson, species.scientific_name)
    : null;
  return (
    <div className="space-y-item">
      <SeasonalityBar seasonality={detail.seasonality} />
      <WeeklyBar weeklyFrequency={detail.weeklyFrequency} regionName={detail.weeklyRegionName} />
      <EncounterSummary encounters={encounters} />
      {/* One iNaturalist link: this region's sightings when there's a region to show, else the
          species. */}
      <div className="flex flex-wrap gap-4 text-xs">
        {(inaturalistUrl || species.inat_taxon_id) && (
          <a
            href={inaturalistUrl ?? `https://www.inaturalist.org/taxa/${species.inat_taxon_id}`}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-ink hover:underline"
          >
            iNaturalist ↗
          </a>
        )}
        {species.ebird_code && (
          <a
            href={`https://ebird.org/species/${species.ebird_code}`}
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-ink hover:underline"
          >
            eBird ↗
          </a>
        )}
      </div>
      {clustered && (
        <SpeciesHotspotMap
          boundaryGeoJson={detail.regionBoundaryGeoJson}
          hotspots={detail.hotspots}
          scientificName={species.scientific_name}
        />
      )}
    </div>
  );
}

/** The species at a glance, in one collapsible card under the photo: its status and field-guide
 *  tags on the left, and your counts and when it's seen in a narrow column on the right. */
export function SpeciesOverview({
  detail,
  encounters,
}: {
  detail: SpeciesDetail;
  encounters: EncountersResponse | null;
}) {
  const { species } = detail;
  const [open, setOpen] = usePersistedState("speciesAboutOpen", true);
  const status = <SpeciesStatus detail={detail} />;
  // Without a chart or map (species added by hand from iNaturalist), the counts and links sit under
  // the notes instead of in a mostly empty side column.
  const hasData = (values: number[] | null) => !!values?.some((v) => v > 0);
  const sideColumn = hasData(detail.seasonality) || hasData(detail.weeklyFrequency) || detail.hotspots.length > 0;
  return (
    <section className={PANEL}>
      <h2>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-base font-semibold text-ink"
        >
          <span className="text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          About
        </button>
      </h2>
      {open && (
        <div className={`mt-3 grid ${sideColumn ? "gap-section lg:grid-cols-[minmax(0,1fr)_24rem]" : "gap-item"}`}>
          <SpeciesNotes species={species} status={status} />
          <SpeciesSightings detail={detail} encounters={encounters} />
        </div>
      )}
    </section>
  );
}

/** Plain for Least Concern and Data Deficient, amber for Near Threatened, red from Vulnerable up,
 *  quiet for Not Evaluated (like the Unrated tier). */
const IUCN_TONE_CLASS: Record<IucnTone, string> = {
  threatened: "text-rose-700 dark:text-rose-300",
  near: "text-amber-700 dark:text-amber-300",
  neutral: "text-ink",
  unassessed: "text-muted",
};
