import { useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import Button from "../../components/Button";
import EmptyState from "../../components/EmptyState";
import type { MenuAction } from "../../components/Menu";
import type { BarAction } from "../../components/SelectionActionRow";
import { formatDate, formatDateSpan } from "../../lib/format";
import { openExternal } from "../../lib/openExternal";
import { useSpeciesName } from "../../lib/speciesName";
import { CardGrid, PhotoWindow, SelectionBar, SpeciesTrail, type GridCard } from "./CardGrid";
import { speciesCard, useSpeciesView } from "./speciesLevel";
import { sortCards, useCardSelection } from "./cardSelection";
import { FilterSelect, InatToolbar, TaxonFilter } from "./Toolbar";
import { taxaIn, useInatView } from "./viewPrefs";
import { previewSlides, usePhotoPreview, type PreviewPhoto } from "./photoPreview";

export type ObservationSummary = {
  observationId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  currentPhotoId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  url: string;
  editUrl: string;
  photoCount: number;
  observedAt: string | null;
  latestAt: string | null;
  photoIds: string[];
  sentLocation: boolean;
  dateFromInat: boolean;
  /** Made on iNaturalist by the user, then found and linked by Lifer. */
  foundOnInat?: boolean;
  taxonClass?: string | null;
  /** Where the photos were taken: place label and region. */
  placeName?: string | null;
  /** The observation's first photo on iNaturalist, for a preview when no photo is here. */
  inatPhotoId?: string | null;
};

type Mode = "pending" | "completed";
type NeedsFilter = "all" | "location" | "date";
type SourceFilter = "all" | "photo" | "inat";
type OriginFilter = "all" | "lifer" | "found";

const icon = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);
const pendingIcon = icon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 3");
const completedIcon = icon("M20 6 9 17l-5-5");

const speciesOf = (o: ObservationSummary) => o.speciesId;

// The photos here, or iNaturalist's own preview when none of them is on this computer.
function previewPhotos(o: ObservationSummary): PreviewPhoto[] {
  if (o.photoIds.length > 0) return o.photoIds.map((photoId) => ({ kind: "local", photoId }));
  return o.inatPhotoId ? [{ kind: "inat", observationId: o.observationId, photoId: o.inatPhotoId }] : [];
}

// What an observation still needs on iNaturalist, from what was sent.
function needsOf(obs: ObservationSummary): "both" | "location" | "date" | "none" {
  if (!obs.sentLocation) return obs.observedAt ? "location" : "both";
  return obs.observedAt ? "none" : "date";
}

function photoLine(t: TFunction, obs: ObservationSummary) {
  const photos = t("inaturalist.photoCount", { count: obs.photoCount });
  return obs.observedAt
    ? t("inaturalist.import.photosAndDate", { photos, date: formatDateSpan(obs.observedAt, obs.latestAt) })
    : photos;
}

/** Where the location and date came from: small print in the window, never on the card. */
function sourceLine(t: TFunction, obs: ObservationSummary) {
  if (obs.foundOnInat) return t("inaturalist.completed.found");
  const location = obs.sentLocation
    ? t("inaturalist.completed.locationPhoto")
    : t("inaturalist.completed.locationInat");
  return obs.dateFromInat ? t("inaturalist.completed.withDateInat", { location }) : location;
}

/** To finish and Completed: the same cards, toolbar, selection and window as To send. To finish
 *  says what each still needs and can be checked now. */
export default function ObservationsTab({
  mode,
  observations,
  notes = {},
  checking = false,
  onCheck,
  onUnlink,
  barSlot,
}: {
  mode: Mode;
  observations: ObservationSummary[];
  /** To finish: what iNaturalist said is still missing, by observation id. */
  notes?: Record<string, string>;
  checking?: boolean;
  /** To finish: asks iNaturalist about these now, or every one when left out. */
  onCheck?: (ids?: string[]) => void;
  /** Undoes a link to an observation found on iNaturalist (only those show it). */
  onUnlink?: (observationId: string) => void;
  barSlot: HTMLElement | null;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const viewPrefs = useInatView();
  const preview = usePhotoPreview();
  const { sort } = viewPrefs;
  const [query, setQuery] = useState("");
  const [needsFilter, setNeedsFilter] = useState<NeedsFilter>("all");
  const [locationFilter, setLocationFilter] = useState<SourceFilter>("all");
  const [dateFilter, setDateFilter] = useState<SourceFilter>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [taxa, setTaxa] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const pending = mode === "pending";

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = observations.filter((o) => {
      if (q && !`${o.commonName ?? ""} ${o.scientificName} ${o.placeName ?? ""}`.toLowerCase().includes(q))
        return false;
      const needs = needsOf(o);
      if (needsFilter === "location" && needs !== "location" && needs !== "both") return false;
      if (needsFilter === "date" && needs !== "date" && needs !== "both") return false;
      if (locationFilter === "photo" && !o.sentLocation) return false;
      if (locationFilter === "inat" && o.sentLocation) return false;
      if (dateFilter === "inat" && !o.dateFromInat) return false;
      if (dateFilter === "photo" && o.dateFromInat) return false;
      if (originFilter === "found" && !o.foundOnInat) return false;
      if (originFilter === "lifer" && o.foundOnInat) return false;
      if (taxa.size > 0 && !taxa.has(o.taxonClass ?? "")) return false;
      return true;
    });
    return sortCards(list, sort, speciesName);
  }, [observations, query, needsFilter, locationFilter, dateFilter, originFilter, taxa, sort, speciesName]);
  const filterCount =
    (needsFilter !== "all" ? 1 : 0) +
    (locationFilter !== "all" ? 1 : 0) +
    (dateFilter !== "all" ? 1 : 0) +
    (originFilter !== "all" ? 1 : 0) +
    (taxa.size > 0 ? 1 : 0);
  function clearFilters() {
    setNeedsFilter("all");
    setLocationFilter("all");
    setDateFilter("all");
    setOriginFilter("all");
    setTaxa(new Set());
  }

  // Grouped by species, one card per species opens onto its observations.
  const view = useSpeciesView(
    items,
    viewPrefs.groupBy,
    sort,
    speciesOf,
    speciesName,
    detailId !== null || preview.isOpen,
  );
  const bySpecies = view.level === "species";
  const visible = view.scoped;
  const visibleKeys = useMemo(
    () => (bySpecies ? view.groups.map((g) => g.speciesId) : visible.map((o) => o.observationId)),
    [bySpecies, view.groups, visible],
  );
  const { selected, setSelected, toggle, clear, selecting, setSelecting } = useCardSelection(
    visibleKeys,
    detailId !== null || preview.isOpen,
  );
  // A selected species stands for all its listed observations. A reload drops ones that moved on.
  const chosen = bySpecies
    ? items.filter((o) => selected.has(o.speciesId))
    : observations.filter((o) => selected.has(o.observationId));
  const filtered = query !== "" || filterCount > 0;

  const open = (o: ObservationSummary) => openExternal(pending ? o.editUrl : o.url);
  const openLabel = pending ? t("inaturalist.pending.finish") : t("inaturalist.send.view");
  const selectLabel = (key: string) =>
    selected.has(key) ? t("inaturalist.import.deselect") : t("inaturalist.import.select");

  // The pictures of one observation, or of a species' observations with one from each first.
  function showPreview(key: string) {
    if (bySpecies) {
      const g = view.groups.find((x) => x.speciesId === key);
      if (!g) return;
      const each = g.items.map(previewPhotos);
      preview.open(
        previewSlides([...each.map((p) => p[0]), ...each.flatMap((p) => p.slice(1))].filter(Boolean), g.name),
      );
      return;
    }
    const o = observations.find((x) => x.observationId === key);
    if (o) preview.open(previewSlides(previewPhotos(o), caption(o)));
  }
  const caption = (o: ObservationSummary) =>
    o.observedAt
      ? t("inaturalist.previewCaption", { name: speciesName(o), date: formatDate(o.observedAt) })
      : speciesName(o);

  const cardMenu = (o: ObservationSummary): MenuAction[] => [
    { label: t("inaturalist.observations.details"), onSelect: () => setDetailId(o.observationId) },
    { label: t("inaturalist.import.preview"), onSelect: () => showPreview(o.observationId) },
    { label: selectLabel(o.observationId), onSelect: () => toggle(o.observationId) },
    { label: openLabel, onSelect: () => open(o) },
    ...(pending
      ? [{ label: t("inaturalist.pending.checkNow"), onSelect: () => onCheck?.([o.observationId]), disabled: checking }]
      : []),
    ...(o.foundOnInat && onUnlink
      ? [{ label: t("inaturalist.matches.unlink"), onSelect: () => onUnlink(o.observationId) }]
      : []),
  ];

  // Only what helps decide or act: what's still missing on To finish, nothing on Completed.
  const statusLine = (o: ObservationSummary) => {
    if (!pending) return null;
    const needs = needsOf(o);
    return notes[o.observationId] ?? (needs === "none" ? null : t("inaturalist.pending.needs", { needs }));
  };

  const speciesCards: GridCard[] = view.groups.map((g) => {
    const needLocation = g.items.filter((o) => !o.sentLocation).length;
    const needDate = g.items.filter((o) => !o.observedAt).length;
    const dates = g.items
      .flatMap((o) => [o.observedAt, o.latestAt])
      .filter((d): d is string => !!d)
      .sort();
    return speciesCard(t, g, {
      itemsLabel: t("inaturalist.observationCount", { count: g.items.length }),
      photoCount: g.items.reduce((n, o) => n + o.photoCount, 0),
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      photos: g.items.map((o) => ({ id: o.observationId, photoId: o.photoIds[0] ?? o.currentPhotoId })),
      status: pending
        ? [
            needLocation ? t("inaturalist.species.needLocation", { count: needLocation }) : null,
            needDate ? t("inaturalist.species.needDate", { count: needDate }) : null,
          ]
        : [],
      menu: [
        { label: t("inaturalist.species.open"), onSelect: () => view.drill.open(g.speciesId) },
        { label: t("inaturalist.import.preview"), onSelect: () => showPreview(g.speciesId) },
        { label: selectLabel(g.speciesId), onSelect: () => toggle(g.speciesId) },
        ...(pending
          ? [
              {
                label: t("inaturalist.pending.checkNow"),
                onSelect: () => onCheck?.(g.items.map((o) => o.observationId)),
                disabled: checking,
              },
            ]
          : []),
      ],
    });
  });

  const observationCards: GridCard[] = visible.map((o) => ({
    key: o.observationId,
    // Inside a species its name would repeat on every card, so the date leads instead.
    name: view.drill.speciesId ? photoLine(t, o) : speciesName(o),
    photos: (o.photoIds.length ? o.photoIds : [o.currentPhotoId]).map((id, i) => ({
      id: id ?? String(i),
      photoId: id,
    })),
    lines: [view.drill.speciesId ? null : photoLine(t, o), o.placeName ?? null, statusLine(o)],
    menu: cardMenu(o),
  }));

  const actions: BarAction[] = pending
    ? [
        {
          key: "check",
          label: t("inaturalist.pending.checkSelected", { count: chosen.length }),
          variant: "primary",
          loading: checking,
          onClick: () => onCheck?.(chosen.map((o) => o.observationId)),
        },
        ...(chosen.length === 1 ? [{ key: "open", label: openLabel, onClick: () => open(chosen[0]) }] : []),
      ]
    : // Nothing bulk here: opening many tabs at once isn't useful, and nothing on Completed is undone.
      chosen.length === 1
      ? [{ key: "open", label: openLabel, variant: "primary", onClick: () => open(chosen[0]) }]
      : [];

  if (observations.length === 0)
    return pending ? (
      <EmptyState
        icon={pendingIcon}
        title={t("inaturalist.pending.empty.title")}
        description={t("inaturalist.pending.empty.description")}
      />
    ) : (
      <EmptyState
        icon={completedIcon}
        title={t("inaturalist.completed.empty.title")}
        description={t("inaturalist.completed.empty.description")}
      />
    );
  const detail = detailId ? observations.find((o) => o.observationId === detailId) : undefined;
  const label = pending ? t("inaturalist.tabs.pending") : t("inaturalist.tabs.completed");
  const openSpecies = view.drill.speciesId ? observations.find((o) => o.speciesId === view.drill.speciesId) : undefined;
  const shownCount = bySpecies ? view.groups.length : visible.length;
  const selectAllLabel = bySpecies ? t("inaturalist.species.selectAll") : t("inaturalist.selectAllObservations");
  const available = taxaIn(observations.map((o) => o.taxonClass));
  const sourceOptions = [
    { value: "all" as const, label: t("inaturalist.import.locationAll") },
    { value: "photo" as const, label: t("inaturalist.completed.fromPhoto") },
  ];

  return (
    <div
      className="space-y-item"
      onClick={(e) => {
        // A click on the tab's own background clears the selection, like Finder.
        if (e.target === e.currentTarget) clear();
      }}
    >
      {pending && <p className="text-subheadline text-muted">{t("inaturalist.pending.steps")}</p>}
      {view.drill.speciesId && (
        <SpeciesTrail speciesName={openSpecies ? speciesName(openSpecies) : ""} onBack={view.drill.back} />
      )}
      <InatToolbar
        search={query}
        onSearch={setQuery}
        shownCount={shownCount}
        selectedCount={chosen.length}
        selectAllLabel={selectAllLabel}
        onSelectAll={() => setSelected(new Set(visibleKeys))}
        onSelectNone={clear}
        selecting={selecting}
        onSelecting={setSelecting}
        view={viewPrefs}
        filterCount={filterCount}
        onClearFilters={clearFilters}
        filters={
          <>
            {pending ? (
              <FilterSelect
                label={t("inaturalist.pending.needsLabel")}
                value={needsFilter}
                onChange={setNeedsFilter}
                options={[
                  { value: "all", label: t("inaturalist.import.locationAll") },
                  { value: "location", label: t("inaturalist.pending.needsLocation") },
                  { value: "date", label: t("inaturalist.pending.needsDate") },
                ]}
              />
            ) : (
              <>
                <FilterSelect
                  label={t("inaturalist.import.locationLabel")}
                  value={locationFilter}
                  onChange={setLocationFilter}
                  options={[...sourceOptions, { value: "inat", label: t("inaturalist.completed.fromInat") }]}
                />
                <FilterSelect
                  label={t("inaturalist.completed.dateLabel")}
                  value={dateFilter}
                  onChange={setDateFilter}
                  options={[...sourceOptions, { value: "inat", label: t("inaturalist.completed.dateFromInat") }]}
                />
                <FilterSelect
                  label={t("inaturalist.toolbar.origin")}
                  value={originFilter}
                  onChange={setOriginFilter}
                  options={[
                    { value: "all", label: t("inaturalist.import.locationAll") },
                    { value: "lifer", label: t("inaturalist.toolbar.sentByLifer") },
                    { value: "found", label: t("inaturalist.completed.found") },
                  ]}
                />
              </>
            )}
            <TaxonFilter available={available} selected={taxa} onChange={setTaxa} />
          </>
        }
      />

      {shownCount > 0 && (
        <SelectionBar
          slot={barSlot}
          selectedCount={chosen.length}
          selectedLabel={
            bySpecies
              ? t("inaturalist.species.selected", {
                  species: selected.size,
                  items: t("inaturalist.observationCount", { count: chosen.length }),
                })
              : undefined
          }
          shownLabel={
            bySpecies
              ? filtered
                ? t("inaturalist.species.count", { count: shownCount })
                : null
              : filtered || view.drill.speciesId
                ? t("inaturalist.observationCount", { count: shownCount })
                : null
          }
          onClear={clear}
          actions={actions}
          idle={
            pending && (
              <Button size="sm" variant="secondary" loading={checking} onClick={() => onCheck?.()}>
                {t("inaturalist.pending.checkNow")}
              </Button>
            )
          }
        />
      )}

      {shownCount === 0 ? (
        <p className="py-8 text-body text-muted">{t("inaturalist.import.noMatch")}</p>
      ) : (
        <CardGrid
          key={`${view.level}|${view.drill.speciesId}|${query}|${filterCount}|${sort}`}
          cards={bySpecies ? speciesCards : observationCards}
          label={label}
          selected={selected}
          onToggle={toggle}
          onSelectAll={() => setSelected(new Set(visibleKeys))}
          onClearSelection={clear}
          onOpen={bySpecies ? view.drill.open : setDetailId}
          onPreview={showPreview}
          selecting={selecting}
          clickOpens={bySpecies}
          cardWidth={viewPrefs.cardSize}
        />
      )}

      {preview.node}
      {detail && (
        <PhotoWindow
          name={speciesName(detail)}
          // Where its location and date came from is small print here, not on the card.
          info={[
            photoLine(t, detail),
            detail.placeName ?? null,
            statusLine(detail),
            pending ? null : sourceLine(t, detail),
          ]}
          photos={detail.photoIds.map((id) => ({ id, photoId: id }))}
          onClose={() => setDetailId(null)}
          footer={
            <>
              {pending && (
                <Button variant="secondary" loading={checking} onClick={() => onCheck?.([detail.observationId])}>
                  {t("inaturalist.pending.checkNow")}
                </Button>
              )}
              {detail.foundOnInat && onUnlink && (
                <Button variant="secondary" onClick={() => onUnlink(detail.observationId)}>
                  {t("inaturalist.matches.unlink")}
                </Button>
              )}
              <Button onClick={() => open(detail)}>{openLabel}</Button>
            </>
          }
        />
      )}
    </div>
  );
}
