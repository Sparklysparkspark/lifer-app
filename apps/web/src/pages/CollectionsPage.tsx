import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useReadyMarker } from "../lib/readyMarker";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { TripSummary, QuadSlot } from "@lifer/shared";
import { api, apiPath, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import { PhotoViewMenu } from "../components/PhotoGridControls";
import { LIST_CARD_SIZE, useListCardSize } from "../hooks/useListCardSize";
import CoverImage from "../components/CoverImage";
import MediaCard from "../components/MediaCard";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "../components/Menu";
import ExportAlbumModal from "./album/ExportAlbumModal";
import RenameModal from "../components/RenameModal";
import TripCard from "../components/TripCard";
import EmptyState from "../components/EmptyState";
import StartTripForm from "./trip/StartTripForm";
import ImportTripForm from "./trip/ImportTripForm";
import InfoTip from "../components/InfoTip";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useEnterToConfirm } from "../hooks/useEnterToConfirm";
import { useToast } from "../hooks/useToast";
import Modal from "../components/Modal";
import Button from "../components/Button";
import SearchInput from "../components/SearchInput";
import SegmentedControl from "../components/SegmentedControl";
import { usePersistedState } from "../hooks/usePersistedState";
import { useTranslation } from "react-i18next";
import { backStateFor } from "../lib/backLabel";
import SmartAlbumBuilder from "./album/SmartAlbumBuilder";
import SmartAlbumLabel from "../components/SmartAlbumLabel";
import type { SmartAlbumRules } from "./gallery/smartAlbumRules";
import { onAccountReset, prefetchApiResource } from "../lib/resource";
import { albumPreviewPath } from "./album/useAlbumDetail";

interface Album {
  id: string;
  name: string;
  description: string | null;
  coverPhotoId: string | null;
  coverLayout: "single" | "quad";
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  quadSlots: Array<QuadSlot | null>;
  createdAt: string;
  captureCount: number;
  /** Set for a smart album, whose rules choose its photos. */
  rules: SmartAlbumRules | null;
}

const TRIPS_INFO_PARAGRAPH_KEYS = [
  "trips.info.pointAtFolder",
  "trips.info.copiedOnImport",
  "trips.info.addMore",
  "trips.info.relocate",
] as const;

// Albums and trips are two full views of one page, switched at the top (?view=trips) and
// remembered across launches. Each keeps its own search, sort and card size.
// The last lists loaded, shown at once on the next visit while a fresh copy loads.
let lastAlbums: Album[] | null = null;
let lastTrips: TripSummary[] | null = null;
onAccountReset(() => {
  lastAlbums = null;
  lastTrips = null;
});
type View = "albums" | "trips";
const isView = (v: unknown): v is View => v === "albums" || v === "trips";
type ListSort = "newest" | "oldest" | "title" | "count";
const LIST_SORTS: readonly ListSort[] = ["newest", "oldest", "title", "count"];

export default function CollectionsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [saved, setSaved] = usePersistedState<View>("albumsPageView", "albums");
  const asked = params.get("view");
  const view: View = isView(asked) ? asked : isView(saved) ? saved : "albums";
  useEffect(() => {
    if (isView(asked) && asked !== saved) setSaved(asked);
  }, [asked, saved, setSaved]);
  const { t } = useTranslation();
  // Switching drops the other side's search; the back-link state stays.
  const switcher = (
    <SegmentedControl
      label={t("albums.sections.switchLabel")}
      value={view}
      onChange={(v) => setParams({ view: v }, { replace: true, state: location.state })}
      options={[
        { value: "albums", label: t("nav.albums") },
        { value: "trips", label: t("nav.trips") },
      ]}
    />
  );
  return (
    <div className="flex-1 bg-canvas">
      {view === "trips" ? <TripsSection switcher={switcher} /> : <AlbumsSection switcher={switcher} />}
    </div>
  );
}

/** A side's name search, kept in the address so Back returns to it. */
function useSectionQuery(): [string, (q: string) => void] {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const setQuery = (q: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set("q", q);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  return [query, setQuery];
}

/** A side's sort, remembered per side. */
function useListSort(key: string): [ListSort, (s: ListSort) => void] {
  const [saved, setSaved] = usePersistedState<ListSort>(key, "newest");
  return [LIST_SORTS.includes(saved) ? saved : "newest", setSaved];
}

/** Name, photo count, or date order; undated items (a trip just started) count as the newest. */
export function sortItems<T extends { name: string; captureCount: number }>(
  items: readonly T[],
  sort: ListSort,
  dateOf: (item: T) => string | null,
): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const time = (item: T) => {
    const d = dateOf(item);
    return d ? Date.parse(d) : Infinity;
  };
  const list = [...items];
  if (sort === "title") return list.sort(byName);
  if (sort === "count") return list.sort((a, b) => b.captureCount - a.captureCount || byName(a, b));
  const dir = sort === "newest" ? -1 : 1;
  return list.sort((a, b) => (time(a) === time(b) ? 0 : time(a) < time(b) ? -dir : dir));
}

/** One side: the shared header (switch on the left; search, View and the side's actions on the
 *  right) over its full grid. */
function SectionFrame({
  title,
  switcher,
  query,
  onQuery,
  searchLabel,
  sort,
  onSort,
  cardSize,
  onCardSize,
  actions,
  children,
}: {
  title: string;
  switcher: ReactNode;
  query: string;
  onQuery: (q: string) => void;
  searchLabel: string;
  sort: ListSort;
  onSort: (s: ListSort) => void;
  cardSize: number;
  onCardSize: (px: number) => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader
        topLevel
        sticky
        title={title}
        actions={
          <>
            <SearchInput value={query} onChange={onQuery} placeholder={searchLabel} aria-label={searchLabel} />
            <PhotoViewMenu
              sections={["sort", "size"]}
              activeCount={sort === "newest" ? 0 : 1}
              sort={{ value: sort, options: LIST_SORTS, onChange: onSort }}
              size={{
                value: cardSize,
                onChange: onCardSize,
                min: LIST_CARD_SIZE.min,
                max: LIST_CARD_SIZE.max,
                step: LIST_CARD_SIZE.step,
              }}
            />
            {actions}
          </>
        }
      >
        {switcher}
      </PageHeader>
      <main className="space-y-section p-page">{children}</main>
    </>
  );
}

/** The side's cards as a grid, filtered by the name search and sorted. */
function SectionCards<T extends { id: string; name: string; captureCount: number }>({
  items,
  query,
  sort,
  dateOf,
  cardSize,
  render,
}: {
  items: T[];
  query: string;
  sort: ListSort;
  dateOf: (item: T) => string | null;
  cardSize: number;
  render: (item: T) => ReactNode;
}) {
  const { t } = useTranslation();
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matched = needle ? items.filter((i) => i.name.toLocaleLowerCase().includes(needle)) : items;
    return sortItems(matched, sort, dateOf);
  }, [items, query, sort, dateOf]);
  if (shown.length === 0) return <EmptyState compact title={t("albums.sections.noMatch", { query: query.trim() })} />;
  return (
    <div className="grid gap-item" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}>
      {shown.map((item) => (
        // Offscreen cards skip style and layout, so 1,000 albums open as fast as 20. Their heights
        // are estimates until drawn, so Back returns by the card at the top, not a pixel offset.
        // The padding (cancelled by the margin) keeps the hover shadow and focus ring unclipped.
        <div
          key={item.id}
          data-scroll-anchor={item.id}
          className="-m-2 p-2"
          style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${cardSize + 80}px` }}
        >
          {render(item)}
        </div>
      ))}
    </div>
  );
}

const albumDate = (a: Album) => a.createdAt;
const tripDate = (trip: TripSummary) => trip.earliestTakenAt;

function AlbumsSection({ switcher }: { switcher: ReactNode }) {
  const [albums, setAlbums] = useState<Album[] | null>(lastAlbums);
  // What the last load threw; only shown when there's no earlier list to show instead.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [renamingAlbum, setRenamingAlbum] = useState<Album | null>(null);
  const [exportingAlbum, setExportingAlbum] = useState<Album | null>(null);
  const [buildingSmart, setBuildingSmart] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { openKey: openMenuId, setOpenKey: setOpenMenuId, ref: openMenuRef } = useDropdownMenu<string>();
  useEnterToConfirm(() => void deleteAlbum(), !!confirmingDeleteId && !deleting);
  useReadyMarker(albums !== null);
  useScrollMemory(albums !== null);
  const [cardSize, setCardSize] = useListCardSize("albumCardMinWidth");
  const [sort, setSort] = useListSort("albumsSort");
  const [query, setQuery] = useSectionQuery();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  function fetchAlbums() {
    api
      .get("/albums")
      .then((res) => setAlbums((lastAlbums = res.albums)))
      .catch((err) => setLoadError(err ?? new Error("load failed")));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(null);
    fetchAlbums();
  }

  useEffect(fetchAlbums, []);

  // Lands in the new album with its name selected, as Photos does; the server names it "Untitled Album".
  function openNewAlbum(albumId: string) {
    navigate(`/albums/${albumId}`, { state: { ...backStateFor(location, t), justCreated: true } });
  }

  async function createAlbum() {
    setSaving(true);
    try {
      openNewAlbum((await api.post("/albums", {})).id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("albums.create.failed"));
      setSaving(false);
    }
  }

  async function renameAlbum(name: string) {
    if (!renamingAlbum) return;
    await api.patch(apiPath("/albums/{id}", { id: renamingAlbum.id }), { name });
    setRenamingAlbum(null);
    toast.success(t("albums.rename.done"));
    load();
  }

  async function deleteAlbum() {
    if (!confirmingDeleteId) return;
    setDeleting(true);
    try {
      await api.delete(apiPath("/albums/{id}", { id: confirmingDeleteId }));
      setConfirmingDeleteId(null);
      toast.success(t("albums.delete.done"));
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("albums.delete.failed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <SectionFrame
        title={t("nav.albums")}
        switcher={switcher}
        query={query}
        onQuery={setQuery}
        searchLabel={t("albums.sections.searchAlbums")}
        sort={sort}
        onSort={setSort}
        cardSize={cardSize}
        onCardSize={setCardSize}
        actions={
          <>
            <Button size="sm" variant="secondary" onClick={() => setBuildingSmart(true)}>
              {t("albums.smart.newSmartAlbum")}
            </Button>
            <Button size="sm" onClick={() => void createAlbum()} loading={saving}>
              {t("albums.list.newAlbum")}
            </Button>
          </>
        }
      >
        {!albums ? (
          loadError ? (
            <EmptyState
              compact
              title={t("albums.list.loadFailed")}
              error={loadError}
              action={{ label: t("common.retry"), onClick: load }}
            />
          ) : (
            <Spinner />
          )
        ) : albums.length === 0 ? (
          // The header has New album, so the empty state doesn't repeat it.
          <EmptyState compact title={t("albums.empty.title")} description={t("albums.empty.description")} />
        ) : (
          <SectionCards
            items={albums}
            query={query}
            sort={sort}
            dateOf={albumDate}
            cardSize={cardSize}
            render={(album) => (
              <MediaCard
                media={
                  <CoverImage
                    layout={album.coverLayout}
                    coverPhotoUrl={album.coverPhotoId ? `/api/photos/${album.coverPhotoId}/thumb` : null}
                    cropX={album.coverCropX}
                    cropY={album.coverCropY}
                    cropSize={album.coverCropSize}
                    quadSlots={album.quadSlots}
                    alt={album.name}
                  />
                }
                title={
                  <>
                    <span title={album.name} className="line-clamp-2">
                      {album.name}
                    </span>
                    {album.rules && <SmartAlbumLabel />}
                  </>
                }
                titleClassName="flex items-center gap-1"
                lines={[t("albums.list.photoCount", { count: album.captureCount })]}
                actions={
                  <Menu
                    open={openMenuId === album.id}
                    onToggle={() => setOpenMenuId(openMenuId === album.id ? null : album.id)}
                    menuRef={openMenuRef}
                    className="relative"
                  >
                    <MenuPanel className="w-36">
                      <MenuItem
                        onSelect={() => {
                          setOpenMenuId(null);
                          setRenamingAlbum(album);
                        }}
                      >
                        {t("common.rename")}
                      </MenuItem>
                      <MenuItem
                        onSelect={() => {
                          setOpenMenuId(null);
                          setExportingAlbum(album);
                        }}
                      >
                        {t("albums.export.action")}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        danger
                        onSelect={() => {
                          setOpenMenuId(null);
                          setConfirmingDeleteId(album.id);
                        }}
                      >
                        {t("common.delete")}
                      </MenuItem>
                    </MenuPanel>
                  </Menu>
                }
                renderBody={(props) => (
                  <Link
                    to={`/albums/${album.id}`}
                    state={backStateFor(location, t)}
                    onMouseEnter={() => prefetchApiResource(albumPreviewPath(album.id))}
                    onFocus={() => prefetchApiResource(albumPreviewPath(album.id))}
                    {...props}
                  />
                )}
              />
            )}
          />
        )}
      </SectionFrame>

      {exportingAlbum && (
        <ExportAlbumModal
          albumId={exportingAlbum.id}
          albumName={exportingAlbum.name}
          onClose={() => setExportingAlbum(null)}
        />
      )}

      {buildingSmart && <SmartAlbumBuilder onClose={() => setBuildingSmart(false)} onSaved={openNewAlbum} />}

      {renamingAlbum && (
        <RenameModal
          title={t("albums.rename.title")}
          initialName={renamingAlbum.name}
          onCancel={() => setRenamingAlbum(null)}
          onSave={renameAlbum}
        />
      )}

      <Modal
        open={!!confirmingDeleteId}
        onClose={() => setConfirmingDeleteId(null)}
        size="sm"
        title={t("albums.delete.title")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingDeleteId(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={deleteAlbum} loading={deleting}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-callout text-muted">{t("albums.delete.body")}</p>
      </Modal>
    </>
  );
}

function TripsSection({ switcher }: { switcher: ReactNode }) {
  const [trips, setTrips] = useState<TripSummary[] | null>(lastTrips);
  // What the last load threw; only shown when there's no earlier list to show instead.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [renamingTrip, setRenamingTrip] = useState<TripSummary | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { openKey: openMenuId, setOpenKey: setOpenMenuId, ref: openMenuRef } = useDropdownMenu<string>();
  useEnterToConfirm(() => void deleteTrip(), !!confirmingDeleteId && !deleting);
  useReadyMarker(trips !== null);
  useScrollMemory(trips !== null);
  const [cardSize, setCardSize] = useListCardSize("tripCardMinWidth");
  const [sort, setSort] = useListSort("tripsSort");
  const [query, setQuery] = useSectionQuery();
  const toast = useToast();
  const location = useLocation();
  const { t } = useTranslation();

  function fetchTrips() {
    api
      .get("/trips")
      .then((res) => setTrips((lastTrips = res.trips)))
      .catch((err) => setLoadError(err ?? new Error("load failed")));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(null);
    fetchTrips();
  }

  useEffect(fetchTrips, []);

  // A trip still scanning its folder refreshes every 2s (paused while the tab is hidden), and
  // nothing lands after the panel unmounts.
  const anyProcessing = !!trips?.some((t) => t.processing);
  useEffect(() => {
    if (!anyProcessing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      if (document.hidden) {
        timer = setTimeout(tick, 2000);
        return;
      }
      api
        .get("/trips")
        .then((res) => {
          if (!cancelled) setTrips((lastTrips = res.trips));
        })
        .catch(() => {
          if (!cancelled) timer = setTimeout(tick, 2000);
        });
    }
    timer = setTimeout(tick, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [anyProcessing, trips]);

  async function renameTrip(name: string) {
    if (!renamingTrip) return;
    await api.patch(apiPath("/trips/{id}", { id: renamingTrip.id }), { name });
    setRenamingTrip(null);
    toast.success(t("trips.rename.done"));
    load();
  }

  async function deleteTrip() {
    if (!confirmingDeleteId) return;
    setDeleting(true);
    try {
      await api.delete(apiPath("/trips/{id}", { id: confirmingDeleteId }));
      setConfirmingDeleteId(null);
      toast.success(t("trips.delete.done"));
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("trips.delete.failed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <SectionFrame
        title={t("nav.trips")}
        switcher={switcher}
        query={query}
        onQuery={setQuery}
        searchLabel={t("albums.sections.searchTrips")}
        sort={sort}
        onSort={setSort}
        cardSize={cardSize}
        onCardSize={setCardSize}
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setStarting(false);
                setCreating(true);
              }}
            >
              {t("trips.list.importTrip")}
            </Button>
            {/* These open a form; each form has its own Cancel. New album keeps the page's one primary. */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setCreating(false);
                setStarting(true);
              }}
            >
              {t("trips.list.startTrip")}
            </Button>
            <InfoTip paragraphs={TRIPS_INFO_PARAGRAPH_KEYS.map((key) => t(key))} align="right" />
          </>
        }
      >
        {starting && <StartTripForm onCancel={() => setStarting(false)} />}
        {creating && <ImportTripForm onCancel={() => setCreating(false)} />}

        {!trips ? (
          loadError ? (
            <EmptyState
              compact
              title={t("trips.list.loadFailed")}
              error={loadError}
              action={{ label: t("common.retry"), onClick: load }}
            />
          ) : (
            <Spinner />
          )
        ) : trips.length === 0 ? (
          // The section has Start a trip, so the empty state doesn't repeat it.
          !(creating || starting) && (
            <EmptyState compact title={t("trips.empty.title")} description={t("trips.empty.description")} />
          )
        ) : (
          <SectionCards
            items={trips}
            query={query}
            sort={sort}
            dateOf={tripDate}
            cardSize={cardSize}
            render={(trip) => (
              <TripCard
                trip={trip}
                menuOpen={openMenuId === trip.id}
                onToggleMenu={() => setOpenMenuId(openMenuId === trip.id ? null : trip.id)}
                menuRef={openMenuRef}
                onRename={() => setRenamingTrip(trip)}
                onDelete={() => setConfirmingDeleteId(trip.id)}
                linkState={backStateFor(location, t, t("nav.trips"))}
              />
            )}
          />
        )}
      </SectionFrame>

      {renamingTrip && (
        <RenameModal
          title={t("trips.rename.title")}
          initialName={renamingTrip.name}
          onCancel={() => setRenamingTrip(null)}
          onSave={renameTrip}
        />
      )}

      <Modal
        open={!!confirmingDeleteId}
        onClose={() => setConfirmingDeleteId(null)}
        size="sm"
        title={t("trips.delete.title")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingDeleteId(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={deleteTrip} loading={deleting}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <p className="text-callout text-muted">{t("trips.delete.body")}</p>
      </Modal>
    </>
  );
}
