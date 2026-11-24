import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Panel from "../../components/Panel";
import type { MenuAction } from "../../components/Menu";
import EmptyState from "../../components/EmptyState";
import SegmentedControl from "../../components/SegmentedControl";
import type { BarAction } from "../../components/SelectionActionRow";
import { CardGrid, PhotoWindow, SelectionBar, SpeciesTrail, type GridCard } from "./CardGrid";
import { speciesCard, useLeaveEmptySpecies, useSpeciesView } from "./speciesLevel";
import { sortCards, useCardSelection } from "./cardSelection";
import { FilterSelect, InatToolbar, TaxonFilter } from "./Toolbar";
import { taxaIn, useInatView } from "./viewPrefs";
import { previewSlides, usePhotoPreview, type PreviewPhoto } from "./photoPreview";
import { Spinner } from "../../components/LoadingScreen";
import { RawFilterFields } from "../../components/PhotoGridControls";
import {
  DEFAULT_RAW_FILES,
  rawFilterParams,
  type EditedRawFilter,
  type RawFilesFilter,
} from "../../lib/photoListFilters";
import { formatDate, formatDateSpan } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import { useToast } from "../../hooks/useToast";
import { useConfirm } from "../../hooks/useConfirm";
import { useSendToInat } from "../../hooks/useSendToInat";
import { ExistingCheckBar, MatchReview, type PossibleMatch } from "./ExistingObservations";
import type { useExistingCheck } from "../../hooks/useExistingCheck";
import { usePlaceStep, type LooksLike } from "../../hooks/usePlaceStep";
import { PlaceChooser } from "../../components/PlaceStep";
import { sentPrivacyLine, usePlaceFiling } from "../../hooks/usePlaceFiling";
import type { Geoprivacy } from "../../components/SavedSpots";
import { useTooltip } from "../../components/Tooltip";
import { formatCoordinates } from "../../lib/coordinates";

export type Sighting = {
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
  matched: boolean;
  taxonClass?: string | null;
  /** Where the photos were taken: place label and region. */
  placeName?: string | null;
  /** The privacy the send will use, from the places the photos are filed under or inside. */
  geoprivacy?: Geoprivacy | null;
  /** A located photo's point, for the place picker's Nearby. */
  point?: { lat: number; lon: number } | null;
  /** A place the photos are at but aren't filed under, to offer. */
  looksLike?: LooksLike | null;
  captures: Array<{ id: string; currentPhotoId: string | null; hasLocation: boolean; onInat: boolean }>;
};

/** The sightings list, or the review of photos that may already be on iNaturalist. */
type View = "list" | "matches";
const MATCHES_VIEW: View = "matches";
type HasFilter = "all" | "has" | "needs";
type MatchedFilter = "all" | "yes" | "no";
type ShowFilter = "waiting" | "ignored" | "both";

const speciesOf = (s: Sighting) => s.speciesId;
const sightingKey = (s: Sighting) => s.captures.map((c) => c.id).join(",");

const sendIcon = (
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
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </svg>
);

/** The To send tab: every sighting not on iNaturalist as a card, with the shared toolbar, a
 *  window to pick its photos, and ignored sightings a filter away. */
export default function SightingsTab({
  sightings,
  ignoredCount,
  raw,
  barSlot,
  onChanged,
  matches,
  check,
}: {
  sightings: Sighting[];
  ignoredCount: number;
  /** The Gallery's RAW filters; the page loads the lists with them, so the server applies them. */
  raw: {
    rawFiles: RawFilesFilter;
    editedRaw: EditedRawFilter;
    setRawFiles: (value: RawFilesFilter) => void;
    setEditedRaw: (value: EditedRawFilter) => void;
  };
  /** Photos that may already be on iNaturalist, for the Maybe on iNaturalist view. */
  matches: PossibleMatch[];
  check: ReturnType<typeof useExistingCheck>;
  /** Where the selection bar renders: inside the sticky page header, so it stays in view. */
  barSlot: HTMLElement | null;
  /** After a send, ignore or restore, to reload the page's lists and counts. */
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const toast = useToast();
  const confirm = useConfirm();
  const sendBatch = useSendToInat();
  const placeStep = usePlaceStep();
  const viewPrefs = useInatView();
  const preview = usePhotoPreview();
  const { sort } = viewPrefs;

  const [params] = useSearchParams();
  // "Check Maybe on iNaturalist" from a toast elsewhere opens straight onto the review.
  const [view, setView] = useState<View>(() => (params.get("show") === "matches" ? "matches" : "list"));
  // Sightings held back because they may already be on iNaturalist, until the user picks.
  const [held, setHeld] = useState<string[][]>([]);
  const [ignored, setIgnored] = useState<Sighting[] | null>(null);
  const [query, setQuery] = useState("");
  const [locationFilter, setLocationFilter] = useState<HasFilter>("all");
  const [dateFilter, setDateFilter] = useState<HasFilter>("all");
  const [matchedFilter, setMatchedFilter] = useState<MatchedFilter>("all");
  const [show, setShow] = useState<ShowFilter>("waiting");
  const [taxa, setTaxa] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Record<string, Set<string>>>({});
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const { rawFiles, editedRaw } = raw;
  const loadIgnored = useCallback(
    () =>
      api.get(apiPath("/inaturalist/import", {}, { ignored: "true", ...rawFilterParams(rawFiles, editedRaw) })).then(
        (r) => setIgnored(r.clusters),
        () => setIgnored([]),
      ),
    [rawFiles, editedRaw],
  );
  useEffect(() => {
    if (show !== "waiting") void loadIgnored();
  }, [show, ignoredCount, loadIgnored]);

  const ignoredKeys = useMemo(() => new Set((ignored ?? []).map(sightingKey)), [ignored]);
  const isIgnored = (s: Sighting) => ignoredKeys.has(sightingKey(s));
  const source = useMemo(() => {
    if (show === "waiting") return sightings;
    if (show === "ignored") return ignored ?? [];
    // Both, newest first like each list.
    return [...sightings, ...(ignored ?? [])].sort((a, b) =>
      (b.latestTakenAt ?? "").localeCompare(a.latestTakenAt ?? ""),
    );
  }, [show, sightings, ignored]);
  const included = (s: Sighting) => {
    const out = excluded[sightingKey(s)];
    return out ? s.captures.filter((c) => !out.has(c.id)) : s.captures;
  };

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = source.filter((s) => {
      if (q && !`${s.commonName ?? ""} ${s.scientificName} ${s.placeName ?? ""}`.toLowerCase().includes(q))
        return false;
      const located = s.captures.some((c) => c.hasLocation);
      if (locationFilter === "has" && !located) return false;
      if (locationFilter === "needs" && located) return false;
      if (dateFilter === "has" && !s.earliestTakenAt) return false;
      if (dateFilter === "needs" && s.earliestTakenAt) return false;
      if (matchedFilter === "yes" && !s.matched) return false;
      if (matchedFilter === "no" && s.matched) return false;
      if (taxa.size > 0 && !taxa.has(s.taxonClass ?? "")) return false;
      return true;
    });
    return sortCards(list, sort, speciesName);
  }, [source, query, locationFilter, dateFilter, matchedFilter, taxa, sort, speciesName]);
  const filterCount =
    (locationFilter !== "all" ? 1 : 0) +
    (dateFilter !== "all" ? 1 : 0) +
    (matchedFilter !== "all" ? 1 : 0) +
    (show !== "waiting" ? 1 : 0) +
    (taxa.size > 0 ? 1 : 0) +
    (raw.rawFiles !== DEFAULT_RAW_FILES ? 1 : 0) +
    (raw.editedRaw !== "any" ? 1 : 0);
  function clearFilters() {
    raw.setRawFiles(DEFAULT_RAW_FILES);
    raw.setEditedRaw("any");
    setLocationFilter("all");
    setDateFilter("all");
    setMatchedFilter("all");
    setShow("waiting");
    setTaxa(new Set());
  }

  // Grouped by species, one card per species opens onto its sightings.
  const speciesView = useSpeciesView(
    items,
    viewPrefs.groupBy,
    sort,
    speciesOf,
    speciesName,
    detailKey !== null || preview.isOpen,
  );
  const bySpecies = speciesView.level === "species";
  const visible = speciesView.scoped;
  const visibleKeys = useMemo(
    () => (bySpecies ? speciesView.groups.map((g) => g.speciesId) : visible.map(sightingKey)),
    [bySpecies, speciesView.groups, visible],
  );
  const { selected, setSelected, toggle, clear, selecting, setSelecting } = useCardSelection(
    visibleKeys,
    detailKey !== null || preview.isOpen,
  );

  // A reload can drop sightings that were selected; only the ones still listed count.
  const byKey = useMemo(() => new Map(source.map((s) => [sightingKey(s), s])), [source]);
  // In list order, so a send goes out in the order the sightings are shown. A selected species
  // stands for all its listed sightings.
  const chosen = bySpecies
    ? items.filter((s) => selected.has(s.speciesId))
    : source.filter((s) => selected.has(sightingKey(s)));
  const sendable = (list: Sighting[]) => list.filter((s) => s.matched && included(s).length > 0);

  function changeView(next: View) {
    setView(next);
    setSelected(new Set());
  }

  async function send(list: Sighting[]) {
    await sendGroups(sendable(list).map((s) => included(s).map((c) => c.id)));
  }

  /** `anyway` only from the notice's Send anyway, never Send all. */
  async function sendGroups(groups: string[][], anyway = false) {
    if (groups.length === 0) return;
    setSending(true);
    setSelected(new Set());
    setDetailKey(null);
    setHeld([]);
    // Each group goes as exactly the photos ticked here, one observation each.
    await sendBatch({ groups }, { onMaybeOnInat: setHeld, ignoreExistingGuard: anyway });
    setSending(false);
    await onChanged();
  }

  const needsPlace = (s: Sighting) => included(s).length > 0 && !included(s).some((c) => c.hasLocation);

  /** Files the ticked photos of the sightings with no location under a chosen place, then
   *  optionally sends the whole list; located sightings keep their own place (A5). */
  async function setPlace(list: Sighting[], thenSend: boolean) {
    // A sighting that has one is changed only when it's the one asked about.
    const unplaced = list.some(needsPlace) ? list.filter(needsPlace) : list;
    const captureIds = unplaced.flatMap((s) => included(s).map((c) => c.id));
    if (!placeStep || captureIds.length === 0) return;
    const offers = new Set(unplaced.map((s) => s.looksLike?.id ?? ""));
    const chosen = await placeStep({
      captureIds,
      near: unplaced.find((s) => s.point)?.point ?? null,
      // Offered only when every sighting looks like the same place.
      looksLike: offers.size === 1 ? (unplaced[0].looksLike ?? null) : null,
      send: thenSend,
    });
    if (chosen !== "placed") return;
    if (thenSend) await send(list);
    else await onChanged();
  }

  async function sendAll() {
    // Send all never includes ignored sightings, whatever the Show filter says.
    const list = sendable(visible.filter((s) => !isIgnored(s)));
    const noLocation = list.filter((s) => !included(s).some((c) => c.hasLocation)).length;
    const ok = await confirm({
      title: t("inaturalist.import.sendAllTitle", { count: list.length }),
      message: t("inaturalist.import.sendAllMessage", { noLocation }),
      confirmLabel: t("inaturalist.import.sendAll"),
    });
    if (ok) await send(list);
  }

  async function setIgnoredFor(captureIds: string[], ignore: boolean, withUndo = true) {
    if (captureIds.length === 0) return;
    try {
      await api.post("/inaturalist/ignore", { captureIds, ignored: ignore });
    } catch {
      toast.error(t("inaturalist.import.ignoreFailed"));
      return;
    }
    setSelected(new Set());
    setDetailKey(null);
    const message = ignore
      ? t("inaturalist.import.ignored", { count: captureIds.length })
      : t("inaturalist.import.restored", { count: captureIds.length });
    if (withUndo)
      toast.show(message, {
        actions: [
          { label: t("inaturalist.import.undo"), onClick: () => void setIgnoredFor(captureIds, !ignore, false) },
        ],
      });
    await onChanged();
    if (show !== "waiting") await loadIgnored();
  }
  const allPhotos = (list: Sighting[]) => list.flatMap((s) => s.captures.map((c) => c.id));
  const toIgnore = chosen.filter((s) => !isIgnored(s));
  const toRestore = chosen.filter(isIgnored);

  // Ignored sightings can still be sent on purpose; sending clears their ignore mark.
  // Send is left out while none of the selection can go (A6).
  const actions: BarAction[] = [
    ...(sendable(chosen).length > 0
      ? [
          {
            key: "send",
            label: t("inaturalist.import.sendSelected", { count: sendable(chosen).length }),
            variant: "primary" as const,
            loading: sending,
            onClick: () => void send(chosen),
          },
        ]
      : []),
    ...(sendable(chosen).some(needsPlace)
      ? [
          {
            key: "placeSend",
            label: t("sendPlace.setPlaceAndSend"),
            loading: sending,
            onClick: () => void setPlace(sendable(chosen), true),
          },
          { key: "place", label: t("sendPlace.setPlace"), onClick: () => void setPlace(chosen, false) },
        ]
      : []),
    ...(toIgnore.length > 0
      ? [
          {
            key: "ignore",
            label: t("inaturalist.import.ignoreSelected", { count: toIgnore.length }),
            onClick: () => void setIgnoredFor(allPhotos(toIgnore), true),
          },
        ]
      : []),
    ...(toRestore.length > 0
      ? [
          {
            key: "restore",
            label: t("inaturalist.import.restoreSelected", { count: toRestore.length }),
            onClick: () => void setIgnoredFor(allPhotos(toRestore), false),
          },
        ]
      : []),
  ];

  const selectLabel = (key: string) =>
    selected.has(key) ? t("inaturalist.import.deselect") : t("inaturalist.import.select");

  // The pictures of one sighting, or of a species' sightings with one from each first.
  const photosOf = (s: Sighting): PreviewPhoto[] =>
    s.captures.flatMap((c) => (c.currentPhotoId ? [{ kind: "local" as const, photoId: c.currentPhotoId }] : []));
  const caption = (s: Sighting) =>
    s.earliestTakenAt
      ? t("inaturalist.previewCaption", { name: speciesName(s), date: formatDate(s.earliestTakenAt) })
      : speciesName(s);
  function showPreview(key: string, index = 0) {
    if (bySpecies) {
      const g = speciesView.groups.find((x) => x.speciesId === key);
      if (!g) return;
      const each = g.items.map(photosOf);
      preview.open(
        previewSlides([...each.map((p) => p[0]), ...each.flatMap((p) => p.slice(1))].filter(Boolean), g.name),
        index,
      );
      return;
    }
    const s = byKey.get(key);
    if (s) preview.open(previewSlides(photosOf(s), caption(s)), index);
  }

  const cardMenu = (s: Sighting): MenuAction[] => {
    const key = sightingKey(s);
    const photos = s.captures.map((c) => c.id);
    const setPlaceItem = {
      // With a location already, the window's word: Change place (A1).
      label: needsPlace(s) ? t("sendPlace.setPlace") : t("inaturalist.import.changePlace"),
      onSelect: () => void setPlace([s], false),
      disabled: included(s).length === 0,
    };
    // First when the card asks for a place, so keyboard users find it where the card's quiet button is.
    const placeFirst = s.matched && needsPlace(s);
    return [
      ...(placeFirst ? [setPlaceItem] : []),
      { label: t("inaturalist.import.choosePhotos"), onSelect: () => setDetailKey(key) },
      { label: t("inaturalist.import.preview"), onSelect: () => showPreview(key) },
      { label: selectLabel(key), onSelect: () => toggle(key) },
      ...(placeFirst ? [] : [setPlaceItem]),
      {
        label: t("inaturalist.send.action"),
        onSelect: () => void send([s]),
        disabled: sending || sendable([s]).length === 0,
      },
      isIgnored(s)
        ? { label: t("inaturalist.import.restoreSighting"), onSelect: () => void setIgnoredFor(photos, false) }
        : { label: t("inaturalist.import.ignoreSighting"), onSelect: () => void setIgnoredFor(photos, true) },
    ];
  };

  const toCard = (s: Sighting): GridCard => {
    const key = sightingKey(s);
    const out = excluded[key];
    const kept = included(s);
    const drilled = speciesView.drill.speciesId !== null;
    return {
      key,
      // Inside a species its name would repeat on every card, so the date leads instead.
      name: drilled ? photoLine(t, s, kept.length) : speciesName(s),
      photos: s.captures.map((c) => ({ id: c.id, photoId: c.currentPhotoId, dim: out?.has(c.id) })),
      lines: [
        drilled ? null : photoLine(t, s, kept.length),
        s.placeName ?? null,
        sentPrivacyLine(t, s.geoprivacy),
        isIgnored(s) ? (
          t("inaturalist.import.ignoredMark")
        ) : (
          <SightingStatus sighting={s} kept={kept} onSetPlace={() => void setPlace([s], false)} />
        ),
      ],
      menu: cardMenu(s),
    };
  };

  const speciesCards: GridCard[] = speciesView.groups.map((g) => {
    const noLocation = g.items.filter((s) => !included(s).some((c) => c.hasLocation)).length;
    const noDate = g.items.filter((s) => !s.earliestTakenAt).length;
    const photos = allPhotos(g.items);
    const dates = g.items
      .flatMap((s) => [s.earliestTakenAt, s.latestTakenAt])
      .filter((d): d is string => !!d)
      .sort();
    const anyIgnored = g.items.some(isIgnored);
    const anyWaiting = g.items.some((s) => !isIgnored(s));
    return speciesCard(t, g, {
      itemsLabel: t("inaturalist.import.shownCount", { count: g.items.length }),
      photoCount: g.items.reduce((n, s) => n + included(s).length, 0),
      earliest: dates[0] ?? null,
      latest: dates[dates.length - 1] ?? null,
      photos: g.items.map((s) => ({ id: sightingKey(s), photoId: s.captures[0]?.currentPhotoId ?? null })),
      status: !g.items[0]?.matched
        ? [t("inaturalist.species.notMatched")]
        : [
            noLocation ? t("inaturalist.species.noLocation", { count: noLocation }) : null,
            noDate ? t("inaturalist.species.noDate", { count: noDate }) : null,
          ],
      menu: [
        { label: t("inaturalist.species.open"), onSelect: () => speciesView.drill.open(g.speciesId) },
        { label: t("inaturalist.import.preview"), onSelect: () => showPreview(g.speciesId) },
        { label: selectLabel(g.speciesId), onSelect: () => toggle(g.speciesId) },
        {
          label: t("inaturalist.import.sendSelected", { count: sendable(g.items).length }),
          onSelect: () => void send(g.items),
          disabled: sending || sendable(g.items).length === 0,
        },
        ...(anyWaiting
          ? [
              {
                label: t("inaturalist.import.ignoreSighting"),
                onSelect: () => void setIgnoredFor(allPhotos(g.items.filter((s) => !isIgnored(s))), true),
              },
            ]
          : []),
        ...(anyIgnored
          ? [
              {
                label: t("inaturalist.import.restoreSighting"),
                onSelect: () => void setIgnoredFor(allPhotos(g.items.filter(isIgnored)), false),
              },
            ]
          : []),
      ].filter(() => photos.length > 0),
    });
  });

  const detail = detailKey ? byKey.get(detailKey) : undefined;
  const openSpecies = speciesView.drill.speciesId
    ? source.find((s) => s.speciesId === speciesView.drill.speciesId)
    : undefined;
  // A species whose last sighting was sent or ignored goes back to the species list.
  const { speciesId: drilledId, back: drillBack } = speciesView.drill;
  const loadingIgnored = show !== "waiting" && ignored === null;
  useLeaveEmptySpecies(drilledId, !openSpecies && !loadingIgnored, drillBack);
  const shownCount = bySpecies ? speciesView.groups.length : visible.length;
  const filtered = query !== "" || filterCount > 0;
  const available = taxaIn([...sightings, ...(ignored ?? [])].map((s) => s.taxonClass));

  const empty =
    show === "ignored"
      ? {
          title: t("inaturalist.import.ignoredEmpty.title"),
          description: t("inaturalist.import.ignoredEmpty.description"),
        }
      : { title: t("inaturalist.import.empty.title"), description: t("inaturalist.import.empty.description") };
  const hasOptions = [
    { value: "all" as const, label: t("inaturalist.import.locationAll") },
    { value: "has" as const, label: t("inaturalist.toolbar.has") },
    { value: "needs" as const, label: t("inaturalist.toolbar.needs") },
  ];

  return (
    <div
      className="space-y-item"
      onClick={(e) => {
        // A click on the tab's own background clears the selection, like Finder.
        if (e.target === e.currentTarget) clear();
      }}
    >
      {/* The review of possible matches is its own list; offered only while there's something in it (A1). */}
      {(matches.length > 0 || view === "matches") && !speciesView.drill.speciesId && (
        <SegmentedControl
          value={view}
          onChange={changeView}
          label={t("inaturalist.import.viewLabel")}
          options={[
            { value: "list", label: t("inaturalist.tabs.import") },
            { value: "matches", label: t("inaturalist.matches.view"), count: matches.length },
          ]}
        />
      )}
      {speciesView.drill.speciesId && (
        <SpeciesTrail speciesName={openSpecies ? speciesName(openSpecies) : ""} onBack={speciesView.drill.back} />
      )}
      {/* The hint reads with the toolbar it explains, as one block. */}
      {view === "list" && (
        <div className="space-y-2">
          <p className="text-subheadline text-muted">{t("inaturalist.import.summary")}</p>
          <InatToolbar
            search={query}
            onSearch={setQuery}
            shownCount={shownCount}
            selecting={selecting}
            onSelecting={setSelecting}
            view={viewPrefs}
            filterCount={filterCount}
            onClearFilters={clearFilters}
            filters={
              <>
                <FilterSelect
                  label={t("inaturalist.import.locationLabel")}
                  value={locationFilter}
                  onChange={setLocationFilter}
                  options={hasOptions}
                />
                <FilterSelect
                  label={t("inaturalist.completed.dateLabel")}
                  value={dateFilter}
                  onChange={setDateFilter}
                  options={hasOptions}
                />
                <FilterSelect
                  label={t("inaturalist.toolbar.matched")}
                  value={matchedFilter}
                  onChange={setMatchedFilter}
                  options={[
                    { value: "all", label: t("inaturalist.import.locationAll") },
                    { value: "yes", label: t("inaturalist.toolbar.matchedYes") },
                    { value: "no", label: t("inaturalist.toolbar.matchedNo") },
                  ]}
                />
                <FilterSelect
                  label={t("inaturalist.toolbar.show")}
                  value={show}
                  onChange={setShow}
                  options={[
                    { value: "waiting", label: t("inaturalist.import.waiting") },
                    { value: "ignored", label: t("inaturalist.toolbar.ignoredCount", { count: ignoredCount }) },
                    { value: "both", label: t("inaturalist.toolbar.both") },
                  ]}
                />
                <TaxonFilter available={available} selected={taxa} onChange={setTaxa} />
                <RawFilterFields
                  rawFiles={raw.rawFiles}
                  editedRaw={raw.editedRaw}
                  onRawFilesChange={raw.setRawFiles}
                  onEditedRawChange={raw.setEditedRaw}
                  sectionHeading
                />
              </>
            }
          />
        </div>
      )}
      {/* Notices go under the toolbar, so one appearing never moves it. */}
      {view === "list" && !speciesView.drill.speciesId && <ExistingCheckBar check={check} />}
      {view === "list" && held.length > 0 && (
        <Panel role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-64 text-callout text-ink">
            {t("inaturalist.send.maybeOnInat", { count: held.length })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setHeld([]);
              changeView(MATCHES_VIEW);
            }}
          >
            {t("inaturalist.send.checkMatches")}
          </Button>
          <Button variant="secondary" size="sm" loading={sending} onClick={() => void sendGroups(held, true)}>
            {t("inaturalist.send.sendAnyway")}
          </Button>
        </Panel>
      )}

      {view === "matches" && <MatchReview matches={matches} onChanged={onChanged} />}

      {view === "list" && shownCount > 0 && (
        <SelectionBar
          slot={barSlot}
          selecting={selecting}
          selectedCount={chosen.length}
          total={bySpecies ? items.length : visible.length}
          onSelectAll={() => setSelected(new Set(visibleKeys))}
          onClear={clear}
          emptyText={t("inaturalist.import.selectHint")}
          // The tab counts sightings; this says how many species they make, or how many a filter or a species leaves.
          shownLabel={
            bySpecies
              ? t("inaturalist.species.count", { count: shownCount })
              : filtered || speciesView.drill.speciesId
                ? t("inaturalist.import.shownCount", { count: visible.length })
                : null
          }
          actions={actions}
          idle={
            sendable(visible.filter((s) => !isIgnored(s))).length > 1 && (
              <Button size="sm" onClick={() => void sendAll()} loading={sending}>
                {t("inaturalist.import.sendAll")}
              </Button>
            )
          }
        />
      )}

      {view === "matches" ? null : show !== "waiting" && ignored === null ? (
        <Spinner />
      ) : shownCount === 0 ? (
        filtered ? (
          <EmptyState
            title={t("inaturalist.import.noMatch")}
            action={{
              label: t("inaturalist.toolbar.clearFilters"),
              onClick: () => {
                setQuery("");
                clearFilters();
              },
            }}
          />
        ) : (
          <EmptyState icon={sendIcon} title={empty.title} description={empty.description} />
        )
      ) : (
        <CardGrid
          key={`${show}|${speciesView.level}|${speciesView.drill.speciesId}|${query}|${filterCount}|${sort}`}
          cards={bySpecies ? speciesCards : visible.map(toCard)}
          label={t("inaturalist.tabs.import")}
          selected={selected}
          onToggle={toggle}
          onSelectAll={() => setSelected(new Set(visibleKeys))}
          onClearSelection={clear}
          onOpen={bySpecies ? speciesView.drill.open : setDetailKey}
          onPreview={showPreview}
          selecting={selecting}
          // A click opens the sighting's window, the same as Enter; the magnifier and Space preview.
          clickOpens
          cardWidth={viewPrefs.cardSize}
        />
      )}

      {preview.node}
      {detail && (
        <SightingDetail
          sighting={detail}
          ignoredView={isIgnored(detail)}
          excludedIds={excluded[sightingKey(detail)] ?? new Set()}
          onExcludedChange={(ids) => setExcluded((prev) => ({ ...prev, [sightingKey(detail)]: ids }))}
          sending={sending}
          onPlaced={() => void onChanged()}
          // The viewer only has the photos that exist, so count those before the clicked one.
          onPhotoOpen={(i) =>
            preview.open(
              previewSlides(photosOf(detail), caption(detail)),
              detail.captures.slice(0, i).filter((c) => c.currentPhotoId).length,
            )
          }
          onClose={() => setDetailKey(null)}
          onSend={() => void send([detail])}
          onIgnore={(ids) => void setIgnoredFor(ids, true)}
          onRestore={() =>
            void setIgnoredFor(
              detail.captures.map((c) => c.id),
              false,
            )
          }
        />
      )}
    </div>
  );
}

/** What iNaturalist won't get from the ticked photos: short on a card, explained in the window.
 *  `placeShown`: the window's place section already speaks for the location. */
function sightingNote(t: TFunction, s: Sighting, kept: Sighting["captures"], short = false, placeShown = false) {
  if (kept.some((c) => c.onInat)) return t("inaturalist.import.onInat");
  if (!s.matched) return t(short ? "inaturalist.import.notMatchedShort" : "inaturalist.import.notMatched");
  const noLocation = !placeShown && kept.length > 0 && !kept.some((c) => c.hasLocation);
  const noDate = !s.earliestTakenAt;
  if (!noLocation && !noDate) return null;
  const missing = noLocation && noDate ? "both" : noLocation ? "location" : "date";
  return t(short ? "inaturalist.import.missingShort" : "inaturalist.import.missing", { missing });
}

function photoLine(t: TFunction, s: Sighting, kept: number) {
  const total = s.captures.length;
  const photos =
    kept < total
      ? t("inaturalist.import.somePhotos", { kept, count: total })
      : t("inaturalist.photoCount", { count: total });
  // No date shows nothing here: the note says it's missing.
  return s.earliestTakenAt
    ? t("inaturalist.import.photosAndDate", { photos, date: formatDateSpan(s.earliestTakenAt, s.latestTakenAt) })
    : photos;
}

function SightingDetail({
  sighting,
  ignoredView,
  excludedIds,
  onExcludedChange,
  sending,
  onPlaced,
  onPhotoOpen,
  onClose,
  onSend,
  onIgnore,
  onRestore,
}: {
  sighting: Sighting;
  ignoredView: boolean;
  excludedIds: Set<string>;
  onExcludedChange: (ids: Set<string>) => void;
  sending: boolean;
  /** After the photos were filed under a place, to reload the sighting. */
  onPlaced: () => void;
  /** Opens the viewer over the window at this photo. */
  onPhotoOpen: (index: number) => void;
  onClose: () => void;
  onSend: () => void;
  onIgnore: (captureIds: string[]) => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const kept = sighting.captures.filter((c) => !excludedIds.has(c.id));
  const leftOut = sighting.captures.filter((c) => excludedIds.has(c.id));
  const located = kept.some((c) => c.hasLocation);
  const sendButton = (
    <Button onClick={onSend} loading={sending} disabled={!sighting.matched || kept.length === 0}>
      {t("inaturalist.import.sendPhotos", { count: kept.length })}
    </Button>
  );
  return (
    <PhotoWindow
      name={speciesName(sighting)}
      info={[
        photoLine(t, sighting, kept.length),
        // The place section names the place when it reads it from the photos.
        located ? null : (sighting.placeName ?? null),
        sentPrivacyLine(t, sighting.geoprivacy),
        sightingNote(t, sighting, kept, false, kept.length > 0),
      ]}
      extra={kept.length > 0 && <SightingPlace sighting={sighting} kept={kept} onPlaced={onPlaced} />}
      photos={sighting.captures.map((c) => ({ id: c.id, photoId: c.currentPhotoId }))}
      onPhotoOpen={onPhotoOpen}
      excludedIds={excludedIds}
      onExcludedChange={onExcludedChange}
      onClose={onClose}
      primary={sendButton}
      footer={
        ignoredView ? (
          <Button variant="secondary" onClick={onRestore}>
            {t("inaturalist.import.restoreSighting")}
          </Button>
        ) : (
          <>
            {leftOut.length > 0 && (
              <Button variant="secondary" onClick={() => onIgnore(leftOut.map((c) => c.id))}>
                {t("inaturalist.import.ignoreUnticked", { count: leftOut.length })}
              </Button>
            )}
            <Button variant="secondary" onClick={() => onIgnore(sighting.captures.map((c) => c.id))}>
              {t("inaturalist.import.ignoreSighting")}
            </Button>
          </>
        )
      }
    />
  );
}

/** A card's status line; "No location yet" is a quiet Set place instead (also in the card's menu). */
function SightingStatus({
  sighting,
  kept,
  onSetPlace,
}: {
  sighting: Sighting;
  kept: Sighting["captures"];
  onSetPlace: () => void;
}) {
  const { t } = useTranslation();
  const note = sightingNote(t, sighting, kept, true);
  const noLocation = sighting.matched && kept.length > 0 && !kept.some((c) => c.hasLocation || c.onInat);
  if (!noLocation) return note && <p className="break-words text-footnote text-muted">{note}</p>;
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-footnote text-muted">
      <Button
        variant="link"
        size="sm"
        // The card is one option; keyboard users have Set place in its menu.
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onSetPlace();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {t("sendPlace.setPlace")}
      </Button>
      {!sighting.earliestTakenAt && <span>{t("inaturalist.import.missingShort", { missing: "date" })}</span>}
    </p>
  );
}

/** In the sighting window. Located photos already give iNaturalist its point (the send uses the
 *  first located one for the whole sighting), so that's one calm line with Change place; with
 *  none, the chooser. Choosing files the ticked photos under the place at once (Undo in the toast). */
function SightingPlace({
  sighting,
  kept,
  onPlaced,
}: {
  sighting: Sighting;
  kept: Sighting["captures"];
  onPlaced: () => void;
}) {
  const { t } = useTranslation();
  const filing = usePlaceFiling(onPlaced);
  const [changing, setChanging] = useState(false);
  const located = kept.filter((c) => c.hasLocation).length;
  const point = sighting.point ?? null;
  const tip = useTooltip(point ? { label: formatCoordinates(point.lat, point.lon) } : undefined);
  const mode = located < kept.length ? "some" : kept.length === 1 ? "one" : "all";
  const from = { mode, located, count: kept.length, place: sighting.placeName ?? "" };
  return (
    <div className="space-y-2">
      {located > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-callout text-ink">
          {/* Focusable so keyboard users get the exact coordinates too. */}
          <span {...tip.props} tabIndex={point ? 0 : undefined} className="break-words">
            {t(sighting.placeName ? "inaturalist.import.locationFromNear" : "inaturalist.import.locationFrom", from)}
          </span>
          {tip.node}
          {!changing && (
            <Button variant="link" size="sm" onClick={() => setChanging(true)}>
              {t("inaturalist.import.changePlace")}
            </Button>
          )}
        </p>
      ) : (
        <p className="text-callout text-ink">{t("inaturalist.import.noLocationChoose", { count: kept.length })}</p>
      )}
      {(located === 0 || changing) && (
        <PlaceChooser
          near={point}
          looksLike={sighting.looksLike ?? null}
          autoFocus={changing}
          onChoose={(place) => {
            setChanging(false);
            void filing.file(
              place,
              kept.map((c) => c.id),
            );
          }}
        />
      )}
      {filing.farNode}
      <FormMessage error={filing.error} />
    </div>
  );
}
