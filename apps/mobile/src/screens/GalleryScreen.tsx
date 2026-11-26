import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useApp, useLocal, useSmartStatus } from "../app/AppContext";
import { galleryFilterCount, useCollectionView } from "../collection/view";
import { choices, toggle, viewAndFilters } from "../collection/viewBar";
import { useHeader } from "../navigation/useHeader";
import { useNav } from "../navigation/types";
import { PhotoGrid } from "../photos/PhotoGrid";
import { COLUMN_STEPS, stepColumns } from "../photos/pinch";
import { removeSearchPart, type SearchPart } from "../search/searchParts";
import { matchSpecies } from "../search/species";
import { libraryShapes, monthPlaces, type LibraryFilter, type ShapedPhoto } from "../store/browse";
import { photoCount, photosForSpecies, type GridPhoto } from "../store/library";
import { allSpecies } from "../store/marks";
import { classesOf } from "../theme/groups";
import { type } from "../theme/theme";
import { useTheme } from "../theme/useTheme";
import { Button, Chip, EmptyState } from "../ui";

const SEARCH_DELAY_MS = 250;

/**
 * Gallery: the whole library by date from the saved thumbnails, and search in the bar. Search works
 * offline over species names and synonyms; when the hub answers, its richer search joins in.
 */
export function GalleryScreen() {
  const { t } = useTranslation();
  const app = useApp();
  const nav = useNav();
  const { colors } = useTheme();
  const { gallery: view, updateGallery: update, clearGalleryFilters } = useCollectionView();
  const [photos, setPhotos] = useState<ShapedPhoto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<GridPhoto[] | null>(null);
  const [hubBusy, setHubBusy] = useState(false);
  const [onPhone, setOnPhone] = useState(false);
  // How the phone read the search, shown as tokens from two parts up like the desktop's.
  const [parts, setParts] = useState<SearchPart[]>([]);
  const searchBar = useRef<SearchBarCommands>(null);
  const smartStatus = useSmartStatus();
  const seq = useRef(0);
  const { data: facets } = useLocal(async (db) => ({
    places: await monthPlaces(db),
    total: await photoCount(db),
  }));

  const filter: LibraryFilter = {
    featured: view.featured || undefined,
    taxonClasses: view.group ? classesOf(view.group) : undefined,
    tripId: view.trip ?? undefined,
    year: view.year ?? undefined,
  };
  const filterKey = JSON.stringify(filter);
  const filtering = filterKey !== "{}";

  // First screenful at once, then the rest: a 60,000 photo library paints before it finishes loading.
  useEffect(() => {
    let alive = true;
    void libraryShapes(app.db, filter, 300).then(async (first) => {
      if (!alive) return;
      setPhotos(first);
      setLoaded(true);
      const all = await libraryShapes(app.db, filter);
      if (alive) setPhotos(all);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.db, app.version, filterKey]);

  useEffect(() => {
    const text = query.trim();
    const mine = ++seq.current;
    if (!text) {
      setFound(null);
      setHubBusy(false);
      setOnPhone(false);
      setParts([]);
      return;
    }
    const timer = setTimeout(async () => {
      // Smart search offline answers on its own: the desktop's query reading and ranking over this phone's data.
      if (app.smart.ready) {
        setHubBusy(true);
        const ranked = await app.smart.search(text);
        if (mine !== seq.current) return;
        setHubBusy(false);
        if (ranked) {
          setFound(ranked.photos);
          setParts(ranked.parts);
          setOnPhone(true);
          return;
        }
      }
      setOnPhone(false);
      setParts([]);
      const species = await allSpecies(app.db);
      const names = matchSpecies(species, text)
        .slice(0, 400)
        .map((s) => s.scientificName);
      const local = await photosForSpecies(app.db, names, text);
      if (mine !== seq.current) return;
      setFound(local);
      if (!app.api) return;
      setHubBusy(true);
      const q = encodeURIComponent(text);
      try {
        const quick = await app.api.get<{ items: GridPhoto[] }>(`/gallery/search?q=${q}&quick=1`);
        if (mine !== seq.current) return;
        const have = new Set(local.map((p) => p.photoId));
        setFound([...local, ...quick.items.filter((p) => !have.has(p.photoId))]);
        // Like the desktop, follow the quick answer with the full search, which adds picture
        // matching ("in flight", "in snow"); its ranking leads, saved-only matches follow.
        const full = await app.api.get<{ items: GridPhoto[] }>(`/gallery/search?q=${q}`);
        if (mine !== seq.current) return;
        const ranked = new Set(full.items.map((p) => p.photoId));
        setFound([...full.items, ...local.filter((p) => !ranked.has(p.photoId))]);
      } catch {
        // offline or refused: the saved matches stand
      } finally {
        if (mine === seq.current) setHubBusy(false);
      }
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, app.db, app.api, app.version, app.smart]);

  useHeader({
    title: t("tabs.gallery"),
    search: { placeholder: t("gallery.searchPlaceholder"), onChange: setQuery, ref: searchBar },
    items: viewAndFilters(
      t,
      [
        {
          type: "submenu",
          label: t("gallery.gridSize"),
          inline: true,
          items: COLUMN_STEPS.map((c) => ({
            type: "action",
            label: t("gallery.across", { n: c }),
            checked: !view.aspect && view.columns === c,
            onPress: () => update({ columns: c, aspect: false }),
          })),
        },
        {
          type: "submenu",
          label: t("gallery.layout"),
          inline: true,
          items: choices(
            ["date", "continuous"] as const,
            view.layout,
            (l) => t(l === "date" ? "gallery.layoutDate" : "gallery.layoutContinuous"),
            (layout) => update({ layout }),
          ),
        },
        toggle(t("gallery.aspect"), view.aspect, (aspect) => update({ aspect })),
      ],
      galleryFilterCount(view),
      () => nav.navigate("Filters", { scope: "gallery" }),
    ),
  });

  const shown: (ShapedPhoto | GridPhoto)[] = found ?? photos;
  const open = (index: number) => nav.navigate("Viewer", { ids: shown.map((p) => p.photoId), index });
  const pinch = useCallback(
    (steps: number) => {
      const next = stepColumns(view.columns, steps);
      if (next !== view.columns || view.aspect) update({ columns: next, aspect: false });
    },
    [view.columns, view.aspect, update],
  );

  if (loaded && photos.length === 0 && !query && !filtering) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas, justifyContent: "center" }}>
        <EmptyState
          icon="gallery"
          title={t("gallery.emptyTitle")}
          line={t(app.mode === "paired" ? "gallery.emptyPaired" : "gallery.empty")}
          action={
            app.mode === "paired" ? undefined : { label: t("welcome.connect"), onPress: () => nav.navigate("Connect") }
          }
        />
      </View>
    );
  }

  const preparing = smartStatus.phase === "downloading" || smartStatus.phase === "syncing";
  const meta = found
    ? hubBusy
      ? t(onPhone || app.smart.ready ? "gallery.searchingPhone" : "gallery.alsoSearching")
      : onPhone
        ? t("gallery.matches", { n: found.length })
        : preparing && app.mode === "paired"
          ? t("gallery.smartPreparing")
          : !app.api || !app.sync.reachable
            ? t("gallery.savedMatches")
            : t("gallery.matches", { n: found.length })
    : filtering
      ? t("gallery.photosFiltered", { n: photos.length })
      : facets?.total
        ? t("gallery.photoCount", { n: facets.total })
        : null;
  const partLabel = (p: SearchPart) => {
    const label = p.kind === "background" ? t("gallery.searchPart.background", { label: p.label }) : p.label;
    return p.exact ? label : t("gallery.searchPart.probably", { label });
  };
  const dropPart = (p: SearchPart) => {
    const next = removeSearchPart(query, p);
    searchBar.current?.setText(next);
    setQuery(next);
  };
  const header = (
    <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 4, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {meta ? (
          <Text style={{ flex: 1, color: colors.muted, fontSize: type.footnote.size }}>{meta}</Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        {filtering && !found ? (
          <Button variant="plain" compact label={t("collection.clearFilters")} onPress={clearGalleryFilters} />
        ) : null}
      </View>
      {found && onPhone && parts.length >= 2 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {parts.map((p, i) => (
            <Chip
              key={`${i}:${p.text}`}
              label={partLabel(p)}
              removeLabel={t("gallery.searchPart.remove", { label: partLabel(p) })}
              onRemove={() => dropPart(p)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <PhotoGrid
        photos={shown}
        byMonth={!found}
        // 16 across is always one seamless grid; the chosen layout returns at fewer columns.
        continuous={view.layout === "continuous" || (!view.aspect && view.columns >= 16)}
        columns={view.columns}
        aspect={view.aspect && !found}
        places={facets?.places}
        onOpen={open}
        onPinch={pinch}
        header={header}
        onRefresh={app.mode === "paired" ? () => void app.sync.run() : undefined}
        refreshing={app.sync.syncing}
        empty={
          found ? (
            <EmptyState icon="search" title={t("gallery.noResults", { query: query.trim() })} />
          ) : filtering ? (
            <EmptyState icon="gallery" title={t("gallery.nothingHere")} />
          ) : undefined
        }
      />
    </View>
  );
}
