import { useEffect, useId, type CSSProperties, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { useAnchoredBox } from "../../lib/anchoredBox";
import { useExclusiveOpen } from "../../lib/exclusivePopover";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import WeeklyBar from "../../components/WeeklyBar";
import SpeciesHotspotMap from "../../components/SpeciesHotspotMap";
import { buildInaturalistObservationsUrl } from "../../lib/inaturalist";
import { useSpeciesName } from "../../lib/speciesName";
import { tierLabel } from "../../lib/speciesGroups";
import { iucnBadge, iucnCategoryName, type IucnTone } from "../../lib/iucnDisplay";
import Panel from "../../components/Panel";
import type { EncountersResponse, NamedCount, SpeciesDetail } from "./types";
import { usePersistedState } from "../../hooks/usePersistedState";
import { FactRow, SpeciesNotes } from "./SpeciesNotes";

export function SpeciesStatus({ detail }: { detail: SpeciesDetail }) {
  const { t } = useTranslation();
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
        ? { value: tierLabel("unrated"), className: "text-muted", title: t("species.status.unratedTitle") }
        : { value: tierLabel(species.tier), title: t("species.status.tierTitle") },
    );
  if (detail.localTier)
    rows.push({
      value: t("species.status.localTier", { tier: tierLabel(detail.localTier) }),
      title: t("species.status.localTierTitle"),
    });
  if (detail.isVagrant)
    rows.push({
      value: t("species.status.vagrant"),
      className: "text-sky-700 dark:text-sky-300",
      title: t("species.status.vagrantTitle"),
    });
  if (detail.isInvasive)
    rows.push({
      value: t("species.status.introduced"),
      className: "text-rose-700 dark:text-rose-300",
      title: t("species.status.introducedTitle"),
    });
  if (detail.endemicCountryName)
    rows.push({
      value: t("species.status.endemic", { country: detail.endemicCountryName }),
      className: "text-amber-700 dark:text-amber-300",
      title: t("species.status.endemicTitle"),
    });
  if (iucn)
    rows.push({
      value:
        iucn.code === "NE"
          ? t("species.status.iucnNotEvaluated")
          : t("species.status.iucn", { category: iucnCategoryName(iucn.code) }),
      className: IUCN_TONE_CLASS[iucn.tone],
      title: iucn.title,
    });
  if (rows.length === 0) return null;
  return (
    <FactRow
      label={t("species.status.label")}
      items={rows.map((row) => ({ text: row.value, className: row.className, title: row.title }))}
    />
  );
}

// `i18nKey` is a plural message whose <n> wraps the number.
function Count({ n, i18nKey }: { n: number; i18nKey: string }) {
  return (
    <span>
      <Trans i18nKey={i18nKey} values={{ count: n }} components={{ n: <span className="font-medium text-ink" /> }} />
    </span>
  );
}

const HOVER_CLOSE_MS = 150;
const LIST_WIDTH_PX = 360;

// Gear names are long; the shared box is only as wide as the small count it hangs from.
function wider(box: CSSProperties): CSSProperties {
  const width = Math.min(LIST_WIDTH_PX, window.innerWidth - 16);
  return { ...box, width, left: Math.max(8, Math.min(Number(box.left), window.innerWidth - width - 8)) };
}

// A count that lists what it counts. Click, tap, Enter or Space always opens it (pinned until
// dismissed); a mouse hover previews it. Rows are plain text: the Gallery has no camera, lens or
// per-species filter to link to.
function CountList({ n, rows, i18nKey }: { n: number; rows: NamedCount[]; i18nKey: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const box = useAnchoredBox(open, buttonRef, boxRef);
  const close = () => {
    clearTimeout(timer.current);
    pinned.current = false;
    setOpen(false);
  };
  useExclusiveOpen(open, close);
  useEscapeToClose(() => {
    close();
    buttonRef.current?.focus();
  }, open);
  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!buttonRef.current?.contains(target) && !boxRef.current?.contains(target)) close();
    };
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const count = <Count n={n} i18nKey={i18nKey} />;
  if (rows.length === 0) return count;
  const hoverOpen = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    setOpen(true);
  };
  const hoverClose = () => {
    if (pinned.current) return;
    timer.current = setTimeout(close, HOVER_CLOSE_MS);
  };
  return (
    <>
      {/* raw-control: the count itself is the trigger, so it keeps the stat line's text style */}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open && pinned.current) return close();
          pinned.current = true;
          clearTimeout(timer.current);
          setOpen(true);
        }}
        onPointerEnter={hoverOpen}
        onPointerLeave={hoverClose}
        className="rounded-control underline decoration-dotted decoration-muted underline-offset-4 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {count}
      </button>
      {open &&
        createPortal(
          <div
            ref={boxRef}
            id={id}
            role="note"
            style={box ? wider(box) : { visibility: "hidden" }}
            onPointerEnter={hoverOpen}
            onPointerLeave={hoverClose}
            className="fixed z-50 overflow-y-auto rounded-panel border border-line bg-surface p-3 text-footnote text-muted shadow-lg"
          >
            <ul className="space-y-1">
              {rows.map((row) => (
                <li key={row.name} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-ink">{row.name}</span>
                  <span className="shrink-0 tabular-nums">
                    {t("species.encounters.rowPhotos", { count: row.count })}
                  </span>
                </li>
              ))}
              {n > rows.length && <li>{t("species.encounters.more", { count: n - rows.length })}</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

// A burst of 400 photos from one sighting is one encounter, not 400.
export function EncounterSummary({ encounters }: { encounters: EncountersResponse | null }) {
  if (!encounters || (encounters.totalPhotos === 0 && encounters.videoCount === 0)) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-footnote text-muted">
      {encounters.totalPhotos > 0 && <Count n={encounters.totalPhotos} i18nKey="species.encounters.photos" />}
      {encounters.videoCount > 0 && <Count n={encounters.videoCount} i18nKey="species.encounters.videos" />}
      <Count n={encounters.encounterCount} i18nKey="species.encounters.encounters" />
      {encounters.locationCount > 0 && (
        <CountList n={encounters.locationCount} rows={encounters.locations} i18nKey="species.encounters.locations" />
      )}
      {encounters.cameraCount > 0 && (
        <CountList n={encounters.cameraCount} rows={encounters.cameras} i18nKey="species.encounters.cameras" />
      )}
      {encounters.lensCount > 0 && (
        <CountList n={encounters.lensCount} rows={encounters.lenses} i18nKey="species.encounters.lenses" />
      )}
    </div>
  );
}

/** The overview's side column: when it's seen, your counts, and where. */
function SpeciesSightings({ detail, encounters }: { detail: SpeciesDetail; encounters: EncountersResponse | null }) {
  const { t } = useTranslation();
  const { species } = detail;
  const speciesName = useSpeciesName();
  const widespread = detail.hotspots.length > 0 && detail.hotspotDistribution === "widespread";
  const clustered = detail.hotspots.length > 0 && !widespread;
  const inaturalistUrl = widespread
    ? buildInaturalistObservationsUrl(detail.regionBoundaryGeoJson, species.scientific_name)
    : null;
  // Regions with hotspots first, then where the user photographed it.
  const offered = [
    ...detail.hotspotAlternatives,
    ...detail.captures.flatMap((c) => (c.region_id && c.region_name ? [{ id: c.region_id, name: c.region_name }] : [])),
  ]
    .filter((r, i, all) => all.findIndex((o) => o.id === r.id) === i && r.name !== detail.hotspotRegionName)
    .slice(0, 6);
  const showEmptyNote = !clustered && !widespread && !!detail.hotspotRegionName && offered.length > 0;
  return (
    <div className="space-y-item">
      <WeeklyBar weeklyFrequency={detail.weeklyFrequency} regionName={detail.weeklyRegionName} />
      <EncounterSummary encounters={encounters} />
      {/* One iNaturalist link: this region's sightings when there's a region to show, else the
          species. */}
      <div className="flex flex-wrap gap-4 text-footnote">
        {(inaturalistUrl || species.inat_taxon_id) && (
          <a
            href={inaturalistUrl ?? `https://www.inaturalist.org/taxa/${species.inat_taxon_id}`}
            // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-ink hover:underline"
          >
            {t("species.links.inaturalist")}
          </a>
        )}
        {species.ebird_code && (
          <a
            href={`https://ebird.org/species/${species.ebird_code}`}
            // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
            target="_blank"
            rel="noreferrer"
            className="text-muted hover:text-ink hover:underline"
          >
            {t("species.links.ebird")}
          </a>
        )}
      </div>
      {(clustered || showEmptyNote) && (
        <SpeciesHotspotMap
          boundaryGeoJson={detail.regionBoundaryGeoJson}
          hotspots={detail.hotspots}
          scientificName={species.scientific_name}
          regionName={detail.hotspotRegionName}
        />
      )}
      {/* Never swap in another region's map: say so, and offer where it does have hotspots or where
          the user photographed it. */}
      {showEmptyNote && (
        <p className="text-footnote text-muted">
          {t("hotspotMap.noneIn", { species: speciesName(species), region: detail.hotspotRegionName })}{" "}
          {offered.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <Link to={`?regionId=${r.id}`} className="hover:text-ink hover:underline">
                {r.name}
              </Link>
            </span>
          ))}
        </p>
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
  const { t } = useTranslation();
  const { species } = detail;
  const [open, setOpen] = usePersistedState("speciesAboutOpen", true);
  const status = <SpeciesStatus detail={detail} />;
  // Without a chart or map (species added by hand from iNaturalist), the counts and links sit under
  // the notes instead of in a mostly empty side column.
  const hasData = (values: number[] | null) => !!values?.some((v) => v > 0);
  const sideColumn = hasData(detail.weeklyFrequency) || detail.hotspots.length > 0;
  return (
    <Panel as="section">
      <h2>
        {/* raw-control: a disclosure heading, the whole title line is the toggle */}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 text-left text-headline font-semibold text-ink"
        >
          <span className="text-muted" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          {t("species.about")}
        </button>
      </h2>
      {open && (
        <div className={`mt-3 grid ${sideColumn ? "gap-section lg:grid-cols-[minmax(0,1fr)_24rem]" : "gap-item"}`}>
          <SpeciesNotes species={species} status={status} />
          <SpeciesSightings detail={detail} encounters={encounters} />
        </div>
      )}
    </Panel>
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
