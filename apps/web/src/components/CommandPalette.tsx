import ProgressiveImg from "./ProgressiveImg";
import { matches, shortcutLabel, type KeyAction } from "../lib/keymap";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { openExternal } from "../lib/openExternal";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { api, apiPath } from "../api/client";
import { useDeploymentMode, useIsTauri } from "../hooks/useDeploymentMode";
import { DEFAULT_RAW_FILES, type EditedRawFilter, type RawFilesFilter } from "../lib/photoListFilters";
import { usePersistedState } from "../hooks/usePersistedState";
import { useRegions } from "../hooks/useRegions";
import { downloadedTaxaByCountry, usePackIndex } from "../lib/packIndex";
import { regionsReachableFrom } from "../lib/regionGrouping";
import { useSettings } from "../hooks/useSettings";
import { backStateFor } from "../lib/backLabel";
import { docsUrl } from "../lib/docs";
import { onAccountReset } from "../lib/resource";
import {
  derivePaletteContext,
  filterEntries,
  flattenGroups,
  GALLERY_MEDIA_PRESET_KEY,
  GALLERY_EDITED_RAW_KEY,
  GALLERY_RAW_FILES_KEY,
  galleryPresetParams,
  galleryScopePath,
  moveHighlight,
  pushRecentQuery,
  resolveHighlight,
  speciesPath,
  type PaletteGroup,
  type PaletteItem,
  type GalleryMediaPreset,
  type StaticEntry,
} from "../lib/search/palette";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchNormalize";
import { GROUPS as SETTINGS_GROUPS } from "../pages/settings/groups";
import EmptyState from "./EmptyState";
import InlineSpinner from "./InlineSpinner";
import Modal from "./Modal";
import SearchInput from "./SearchInput";
import { ignore } from "../lib/ignore";
import { pageNumber } from "../lib/mainPages";
import { isTauri } from "../lib/tauri";
import { namePartClass, useSpeciesName, useSpeciesNameParts } from "../lib/speciesName";
import SpeciesNameText from "./SpeciesNameText";
import { IconButton } from "./Button";
import { TOUR_STATE } from "./Tour";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";

interface SpeciesHit {
  id: string;
  scientific_name: string;
  common_name: string | null;
  aba_code?: string | null;
  ebird_code?: string | null;
}

interface PhotoHit {
  photoId: string;
  speciesId?: string;
  commonName: string | null;
  scientificName: string;
}

type Named = { id: string; name: string };

// The gallery ignores shorter queries, so the palette does too.
const MIN_PHOTO_QUERY = 3;
const PHOTO_LIMIT = 6;

// Shown from the last fetch straight away, then refreshed on each open so a new trip or album
// appears; a failed fetch keeps the last good lists.
let listsCache: Promise<{ trips: Named[]; albums: Named[] }> | null = null;
let listsGeneration = 0;
onAccountReset(() => {
  listsCache = null;
  listsGeneration++;
});
function loadLists(fresh = false) {
  if (!listsCache || fresh) {
    const previous = listsCache;
    const generation = listsGeneration;
    let failed = false;
    const soft = <T,>(p: Promise<T>, fallback: T) =>
      p.catch(() => {
        failed = true;
        return fallback;
      });
    listsCache = Promise.all([
      soft(
        api.get("/trips").then((r) => r.trips),
        [],
      ),
      soft(
        api.get("/albums").then((r) => r.albums),
        [],
      ),
    ]).then(([trips, albums]) => {
      // A sign-out since this started means `previous` belongs to the last account.
      if (!failed || generation !== listsGeneration) return { trips, albums };
      listsCache = previous;
      return previous ?? { trips, albums };
    });
  }
  return listsCache;
}

// The desktop menu binds the page chords; a browser keeps its own tab shortcuts, so no hint there.
function pageChord(action: StaticEntry["action"]): string | undefined {
  const n = action.type === "navigate" && !action.state && isTauri() ? pageNumber(action.to) : null;
  return n ? shortcutLabel(`page${n}` as KeyAction) : undefined;
}

// Labels are i18n keys, translated when the groups are built.
const ACTIONS: (Omit<StaticEntry, "label" | "sublabel"> & { labelKey: string; sublabelKey?: string })[] = [
  {
    id: "action:import",
    labelKey: "commandPalette.actions.import",
    keywords: ["upload", "add"],
    action: { type: "navigate", to: "/import" },
  },
  {
    id: "action:gallery",
    labelKey: "commandPalette.actions.gallery",
    keywords: ["photos"],
    action: { type: "navigate", to: "/gallery" },
  },
  {
    id: "action:similar",
    labelKey: "commandPalette.actions.similar",
    keywords: ["duplicates", "burst", "compare"],
    action: { type: "navigate", to: "/gallery/similar" },
  },
  {
    id: "action:albums",
    labelKey: "commandPalette.actions.albums",
    keywords: ["collections"],
    action: { type: "navigate", to: "/albums" },
  },
  {
    id: "action:trips",
    labelKey: "commandPalette.actions.trips",
    keywords: ["travel"],
    // The Albums page's other side.
    action: { type: "navigate", to: "/albums?view=trips" },
  },
  {
    id: "action:stats",
    labelKey: "commandPalette.actions.stats",
    keywords: ["statistics", "charts"],
    action: { type: "navigate", to: "/stats" },
  },
  {
    id: "action:review",
    labelKey: "commandPalette.actions.review",
    keywords: ["confirm", "identifications", "suggestions"],
    action: { type: "navigate", to: "/review" },
  },
  {
    id: "action:offline",
    labelKey: "commandPalette.actions.offline",
    keywords: ["download", "pack", "regions", "maps"],
    action: { type: "navigate", to: SPECIES_DOWNLOADS_PATH },
  },
  {
    id: "action:trash",
    labelKey: "commandPalette.actions.trash",
    keywords: ["deleted", "restore"],
    action: { type: "navigate", to: "/trash" },
  },
  {
    id: "action:tour",
    labelKey: "tour.start",
    keywords: ["tutorial", "guide", "help", "intro", "welcome"],
    action: { type: "navigate", to: "/", state: TOUR_STATE },
  },
  {
    id: "action:help",
    labelKey: "commandPalette.actions.help",
    sublabelKey: "commandPalette.actions.helpSublabel",
    keywords: ["docs", "guide"],
    action: { type: "external", url: docsUrl("/intro") },
  },
];

export default function CommandPalette({
  onClose,
  onInatSearch,
}: {
  onClose: () => void;
  /** Opens the iNaturalist search after the palette closes (the provider owns that modal). */
  onInatSearch?: (query: string, regionId: string | null) => void;
}) {
  const speciesName = useSpeciesName();
  const speciesNameParts = useSpeciesNameParts();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const context = useMemo(
    () => derivePaletteContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const { regions: allRegions } = useRegions();
  // Only regions reachable from a downloaded country, as the Collection offers; none until known.
  const { packs } = usePackIndex();
  const regions = useMemo(() => {
    if (!allRegions || !packs) return null;
    const reachable = regionsReachableFrom(allRegions, new Set(downloadedTaxaByCountry(packs).keys()));
    return allRegions.filter((r) => reachable.has(r.id));
  }, [allRegions, packs]);
  const mode = useDeploymentMode();
  const inTauri = useIsTauri();
  const [recentQueries, setRecentQueries] = usePersistedState<string[]>("paletteRecentQueries", []);
  // Read only: the Gallery owns these presets, the palette just hides what the Gallery hides.
  const [rawFiles] = usePersistedState<RawFilesFilter>(GALLERY_RAW_FILES_KEY, DEFAULT_RAW_FILES);
  const [editedRaw] = usePersistedState<EditedRawFilter>(GALLERY_EDITED_RAW_KEY, "any");
  const [mediaPreset] = usePersistedState<GalleryMediaPreset>(GALLERY_MEDIA_PRESET_KEY, "photos");
  const { settings } = useSettings();
  const anyTaxaSearchEnabled = settings?.anyTaxaSearchEnabled ?? false;

  const [query, setQuery] = useState("");
  const [regionDismissed, setRegionDismissed] = useState(false);
  const regionId = regionDismissed ? null : context.regionId;
  const [species, setSpecies] = useState<SpeciesHit[]>([]);
  const [photos, setPhotos] = useState<PhotoHit[]>([]);
  const [pending, setPending] = useState(0);
  const [lists, setLists] = useState<{ trips: Named[]; albums: Named[] } | null>(null);
  const [scopePhotos, setScopePhotos] = useState<PhotoHit[]>([]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    let live = true;
    const cached = listsCache;
    if (cached) cached.then((l) => live && setLists(l));
    loadLists(true).then((l) => live && setLists(l));
    return () => {
      live = false;
    };
  }, []);

  // A trip or album page: the same photo search, narrowed to that trip or album.
  const scope = context.scope;
  const scopeKind = scope?.kind ?? null;
  const scopeId = scope?.id ?? null;

  // Server-backed groups. Old results stay up until new ones land, so nothing flickers.
  const trimmed = query.trim();
  useEffect(() => {
    const controller = new AbortController();
    const track = <T,>(p: Promise<T>, apply: (v: T) => void) => {
      setPending((n) => n + 1);
      p.then((v) => !controller.signal.aborted && apply(v))
        .catch(ignore("Command palette search failed"))
        .finally(() => setPending((n) => n - 1));
    };
    const timer = setTimeout(
      () => {
        const params = new URLSearchParams({ q: trimmed });
        if (regionId) params.set("regionId", regionId);
        track(api.get(apiPath("/species", {}, params), { signal: controller.signal }), (r) =>
          setSpecies(r.results.slice(0, 6)),
        );
        if (trimmed.length >= MIN_PHOTO_QUERY) {
          const photoParams = new URLSearchParams({
            q: trimmed,
            quick: "1",
            ...galleryPresetParams(rawFiles, editedRaw, mediaPreset),
          });
          track(api.get(apiPath("/gallery/search", {}, photoParams), { signal: controller.signal }), (r) =>
            setPhotos(r.items.slice(0, PHOTO_LIMIT)),
          );
          if (scopeKind && scopeId) {
            const scopeParams = new URLSearchParams(photoParams);
            scopeParams.set(scopeKind === "trip" ? "tripId" : "albumId", scopeId);
            track(api.get(apiPath("/gallery/search", {}, scopeParams), { signal: controller.signal }), (r) =>
              setScopePhotos(r.items.slice(0, PHOTO_LIMIT)),
            );
          } else {
            setScopePhotos([]);
          }
        } else {
          setPhotos([]);
          setScopePhotos([]);
        }
      },
      trimmed ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, regionId, rawFiles, editedRaw, mediaPreset, scopeKind, scopeId]);

  const regionName = useMemo(
    () => (regionId ? (allRegions?.find((r) => r.id === regionId)?.name ?? null) : null),
    [allRegions, regionId],
  );
  const scopeName =
    scope &&
    (scope.kind === "trip"
      ? lists?.trips.find((t) => t.id === scope.id)?.name
      : lists?.albums.find((a) => a.id === scope.id)?.name);

  const groups = useMemo<PaletteGroup[]>(() => {
    const speciesItems: PaletteItem[] = species.map((s) => {
      const { primary, secondary } = speciesNameParts(s);
      return {
        id: `species:${s.id}`,
        label: primary.text,
        labelClass: namePartClass(primary),
        sublabelParts: secondary,
        action: { type: "navigate", to: speciesPath(s.id, regionId) },
      };
    });
    const photoItem = (prefix: string, p: PhotoHit, fallbackTo: string): PaletteItem => ({
      id: `${prefix}:${p.photoId}`,
      label: speciesName(p),
      thumbUrl: `/api/photos/${p.photoId}/thumb`,
      action: { type: "navigate", to: p.speciesId ? speciesPath(p.speciesId, null) : fallbackTo },
    });
    const actionEntries: StaticEntry[] = ACTIONS.map(({ labelKey, sublabelKey, ...entry }) => ({
      ...entry,
      label: t(labelKey),
      sublabel: sublabelKey ? t(sublabelKey) : pageChord(entry.action),
    }));

    if (!trimmed) {
      return [
        {
          id: "recent",
          title: t("commandPalette.groups.recentSearches"),
          items: recentQueries.map((q) => ({ id: `recent:${q}`, label: q, action: { type: "setQuery", query: q } })),
        },
        { id: "species", title: t("commandPalette.groups.recentSpecies"), items: speciesItems },
        {
          id: "actions",
          title: t("commandPalette.groups.goTo"),
          items: filterEntries(actionEntries, "", actionEntries.length),
        },
      ];
    }

    // The iNaturalist fallback, for taxa Lifer has no data for.
    if (anyTaxaSearchEnabled && onInatSearch && trimmed.length >= 2) {
      speciesItems.push({
        id: "species:inat",
        label:
          speciesItems.length === 0
            ? t("commandPalette.inat.noLocalMatch", { query: trimmed })
            : t("commandPalette.inat.search"),
        sublabel: t("commandPalette.inat.sublabel"),
        action: { type: "inatSearch", query: trimmed },
      });
    }

    const photoGroup: PaletteItem[] = photos.map((p) =>
      photoItem("photo", p, `/gallery?q=${encodeURIComponent(trimmed)}`),
    );
    if (trimmed.length >= MIN_PHOTO_QUERY) {
      photoGroup.push({
        id: "photos:all",
        label: t("commandPalette.searchAllPhotos", { query: trimmed }),
        action: { type: "navigate", to: `/gallery?q=${encodeURIComponent(trimmed)}` },
      });
    }

    const scopeGroup: PaletteItem[] = [];
    if (scope && trimmed.length >= MIN_PHOTO_QUERY) {
      const scopeGallery = galleryScopePath(scope, trimmed);
      scopeGroup.push(...scopePhotos.map((p) => photoItem("scope", p, scopeGallery)));
      scopeGroup.push({
        id: "scope:all",
        label:
          scope.kind === "trip"
            ? t("commandPalette.searchTripPhotos", { query: trimmed })
            : t("commandPalette.searchAlbumPhotos", { query: trimmed }),
        action: { type: "navigate", to: scopeGallery },
      });
    }

    const regionParents = new Map((allRegions ?? []).map((r) => [r.id, r.name]));
    const regionEntries: StaticEntry[] = (regions ?? []).map((r) => ({
      id: `region:${r.id}`,
      label: r.name,
      sublabel: r.parentId ? regionParents.get(r.parentId) : undefined,
      keywords: r.ebirdRegionCode ? [r.ebirdRegionCode] : undefined,
      action: { type: "navigate", to: `/?region=${encodeURIComponent(r.id)}` },
    }));
    const tripEntries: StaticEntry[] = (lists?.trips ?? []).map((t) => ({
      id: `trip:${t.id}`,
      label: t.name,
      action: { type: "navigate", to: `/trips/${t.id}` },
    }));
    const albumEntries: StaticEntry[] = (lists?.albums ?? []).map((a) => ({
      id: `album:${a.id}`,
      label: a.name,
      action: { type: "navigate", to: `/albums/${a.id}` },
    }));
    const settingsEntries: StaticEntry[] = SETTINGS_GROUPS.filter((g) => g.visible({ mode, isTauri: inTauri })).map(
      (g) => ({
        id: `settings:${g.id}`,
        label: g.label,
        sublabel: t("commandPalette.groups.settings"),
        keywords: ["settings", "preferences"],
        action: { type: "navigate", to: `/settings/${g.id}` },
      }),
    );

    return [
      {
        id: "species",
        title: regionName
          ? t("commandPalette.groups.speciesRegionFirst", { region: regionName })
          : t("commandPalette.groups.species"),
        items: speciesItems,
      },
      {
        id: "scope",
        title:
          scope?.kind === "album"
            ? scopeName
              ? t("commandPalette.groups.albumPhotosNamed", { name: scopeName })
              : t("commandPalette.groups.albumPhotos")
            : scopeName
              ? t("commandPalette.groups.tripPhotosNamed", { name: scopeName })
              : t("commandPalette.groups.tripPhotos"),
        items: scopeGroup,
      },
      { id: "photos", title: t("commandPalette.groups.photos"), items: photoGroup },
      { id: "regions", title: t("commandPalette.groups.regions"), items: filterEntries(regionEntries, trimmed, 5) },
      { id: "trips", title: t("commandPalette.groups.trips"), items: filterEntries(tripEntries, trimmed, 4) },
      { id: "albums", title: t("commandPalette.groups.albums"), items: filterEntries(albumEntries, trimmed, 4) },
      { id: "settings", title: t("commandPalette.groups.settings"), items: filterEntries(settingsEntries, trimmed, 4) },
      { id: "actions", title: t("commandPalette.groups.goTo"), items: filterEntries(actionEntries, trimmed, 4) },
    ];
  }, [
    t,
    speciesName,
    speciesNameParts,
    trimmed,
    species,
    photos,
    recentQueries,
    regionId,
    regionName,
    regions,
    allRegions,
    lists,
    scope,
    scopePhotos,
    scopeName,
    mode,
    inTauri,
    anyTaxaSearchEnabled,
    onInatSearch,
  ]);

  const flat = useMemo(() => flattenGroups(groups), [groups]);
  const active = resolveHighlight(flat.items, highlightedId);
  const activeItem = active >= 0 ? flat.items[active] : null;
  const optionId = (item: PaletteItem) => `${listId}-${item.id}`;

  const activeOptionId = activeItem ? optionId(activeItem) : null;
  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId]);

  function activate(item: PaletteItem) {
    const { action } = item;
    if (action.type === "setQuery") {
      setQuery(action.query);
      setHighlightedId(null);
      inputRef.current?.focus();
      return;
    }
    if (trimmed) setRecentQueries(pushRecentQuery(recentQueries, trimmed));
    onClose();
    // Like any link: the page it opens can name and return to the one the palette was opened on.
    if (action.type === "navigate") navigate(action.to, { state: action.state ?? backStateFor(location, t) });
    else if (action.type === "inatSearch") onInatSearch?.(action.query, regionId);
    else openExternal(action.url);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (matches(e, "listNext") || matches(e, "listPrevious")) {
      e.preventDefault();
      const next = moveHighlight(active, matches(e, "listNext") ? 1 : -1, flat.items.length);
      if (next >= 0) setHighlightedId(flat.items[next].id);
    } else if (matches(e, "choose")) {
      e.preventDefault();
      if (activeItem) activate(activeItem);
    }
  }

  const loading = pending > 0;
  const nothingFound = !!trimmed && flat.items.length === 0 && !loading;

  function renderOption(item: PaletteItem) {
    const selected = item.id === activeItem?.id;
    const common = {
      id: optionId(item),
      role: "option" as const,
      "aria-selected": selected,
      onMouseMove: () => !selected && setHighlightedId(item.id),
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onClick: () => activate(item),
    };
    if (item.thumbUrl) {
      return (
        <div
          key={item.id}
          {...common}
          aria-label={item.label}
          title={item.label}
          className={`aspect-square cursor-pointer overflow-hidden rounded-control bg-surface-muted ${selected ? "ring-2 ring-accent" : ""}`}
        >
          <ProgressiveImg thumbSrc={item.thumbUrl} alt="" className="h-full w-full object-cover" />
        </div>
      );
    }
    return (
      <div
        key={item.id}
        {...common}
        className={`flex cursor-pointer items-baseline gap-2 rounded-control px-2.5 py-1.5 text-callout ${selected ? "bg-surface-muted" : ""}`}
      >
        <span className={`truncate text-ink ${item.labelClass ?? ""}`}>{item.label}</span>
        {(item.sublabel || (item.sublabelParts?.length ?? 0) > 0) && (
          <span className="truncate text-footnote text-muted">
            {item.sublabelParts ? <SpeciesNameText parts={item.sublabelParts} /> : item.sublabel}
          </span>
        )}
      </div>
    );
  }

  return (
    <Modal open onClose={onClose} ariaLabel={t("commandPalette.label")} size="lg" initialFocusRef={inputRef}>
      <div className="flex items-center gap-2">
        <SearchInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setHighlightedId(null);
          }}
          placeholder={t("commandPalette.placeholder")}
          aria-label={t("commandPalette.label")}
          className="flex-1"
          onKeyDown={handleKeyDown}
          inputRef={inputRef}
          inputProps={{
            role: "combobox",
            autoComplete: "off",
            spellCheck: false,
            "aria-autocomplete": "list",
            "aria-expanded": flat.items.length > 0,
            "aria-controls": listId,
            "aria-activedescendant": activeItem ? optionId(activeItem) : undefined,
          }}
        />
        <span className="flex w-4 justify-center">
          {loading && <InlineSpinner size="sm" label={t("commandPalette.searching")} />}
        </span>
        <IconButton
          tone="plain"
          onClick={onClose}
          aria-label={t("commandPalette.close")}
          className="text-title-3 leading-none hover:bg-surface-muted"
        >
          ×
        </IconButton>
      </div>

      {regionId && regionName && (
        <div className="mt-2 flex">
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-footnote text-ink">
            {t("commandPalette.inRegion", { region: regionName })}
            <IconButton
              tone="plain"
              onClick={() => {
                setRegionDismissed(true);
                inputRef.current?.focus();
              }}
              aria-label={t("commandPalette.searchEverywhere", { region: regionName })}
              className="h-4! min-w-4! text-callout leading-none"
            >
              ×
            </IconButton>
          </span>
        </div>
      )}

      <div
        id={listId}
        role="listbox"
        aria-label={t("commandPalette.results")}
        className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto"
      >
        {nothingFound ? (
          <EmptyState
            icon={
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
            }
            title={t("commandPalette.empty.title", { query: trimmed })}
            description={t("commandPalette.empty.description")}
          />
        ) : (
          flat.groups.map((group) => {
            const thumbs = group.items.filter((i) => i.thumbUrl);
            const rows = group.items.filter((i) => !i.thumbUrl);
            return (
              <div key={group.id} role="group" aria-labelledby={`${listId}-g-${group.id}`}>
                <div id={`${listId}-g-${group.id}`} className="px-2.5 pb-1 text-footnote font-medium text-muted">
                  {group.title}
                </div>
                {thumbs.length > 0 && (
                  <div className="mb-1 grid grid-cols-6 gap-1.5 px-1">{thumbs.map(renderOption)}</div>
                )}
                {rows.map(renderOption)}
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
