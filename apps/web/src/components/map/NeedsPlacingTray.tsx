import { useEffect, useRef, useState } from "react";
import { useApiRoute } from "../../lib/resource";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../../api/client";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate, formatDateSpan, formatNumber } from "../../lib/format";
import Button from "../Button";
import EmptyState from "../EmptyState";
import FormMessage from "../FormMessage";
import PhotoTile from "../PhotoTile";
import Lightbox from "../Lightbox";
import Menu, { MenuItems, MenuPanel } from "../Menu";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import ProgressiveImg from "../ProgressiveImg";
import SegmentedControl from "../SegmentedControl";
import InlineSpinner from "../InlineSpinner";

export type PlacingGroup = ApiResponse<"/gallery/map/unplaced">["groups"][number];
export type TrayState = "all" | "region" | "none";

/** What a Place button or a drop on the map places: the ids are fetched only then. */
export interface PlaceSource {
  count: number;
  regionId: string | null;
  regionName: string | null;
  ids: () => Promise<string[]>;
  /** Removes it from the tray once placed. */
  key: string;
}

/** The filtered photos without coordinates, grouped as shot, each with a Place button. */
export default function NeedsPlacingTray({
  queryString,
  counts,
  pinDown,
  notes,
  refreshKey,
  busy,
  onPlace,
  onDragSource,
}: {
  queryString: string;
  counts: Record<TrayState, number>;
  /** A pin is on the map: Place puts photos there; without one it drops a pin to drag first. */
  pinDown: boolean;
  /** A line under a group's Place button about the pin (outside its region, moves its region). */
  notes: (source: { count: number; regionId: string | null; regionName: string | null }) => string | null;
  refreshKey: number;
  busy: boolean;
  onPlace: (source: PlaceSource) => void;
  /** A group (or its ticked photos) is being dragged towards the map; null when the drag ends. */
  onDragSource: (source: PlaceSource | null) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<TrayState>("all");
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const params = (extra: Record<string, string>) => {
    const p = new URLSearchParams(queryString);
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return p;
  };
  const first = useApiRoute(apiPath("/gallery/map/unplaced", {}, params({ state })));
  // Later pages, kept only while they follow the first page they were loaded after.
  const [more, setMore] = useState<{ after: object | null; groups: PlacingGroup[]; cursor: string | null }>({
    after: null,
    groups: [],
    cursor: null,
  });
  const extra = first.data && more.after === first.data ? more : null;
  const groups = first.data ? [...first.data.groups, ...(extra?.groups ?? [])] : null;
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);
  const reload = first.reload;
  useEffect(() => {
    if (refreshKey > 0) void reload();
  }, [refreshKey, reload]);
  const loadError = first.error ? errorMessage(first.error, t("gallery.map.loadFailed")) : null;

  async function loadMore(next: string) {
    const res = await api.get(apiPath("/gallery/map/unplaced", {}, params({ state, cursor: next })));
    setMore({ after: first.data, groups: [...(extra?.groups ?? []), ...res.groups], cursor: res.nextCursor });
  }

  const photosOf = (g: PlacingGroup) => api.get(apiPath("/gallery/map/unplaced/photos", {}, params({ key: g.key })));
  const groupSource = (g: PlacingGroup, ticked?: string[]): PlaceSource => ({
    key: g.key,
    count: ticked?.length || g.count,
    regionId: g.regionId,
    regionName: g.regionName,
    ids: async () => (ticked?.length ? ticked : (await photosOf(g)).captureIds),
  });

  const total = counts[state];
  return (
    <div className="space-y-3">
      <SegmentedControl
        label={t("gallery.map.tray.filterLabel")}
        value={state}
        onChange={setState}
        options={[
          { value: "all", label: t("gallery.map.tray.all"), count: counts.all },
          { value: "region", label: t("gallery.map.tray.region"), count: counts.region },
          { value: "none", label: t("gallery.map.tray.none"), count: counts.none },
        ]}
      />
      <FormMessage error={error ?? loadError} />
      {!groups && !loadError && <InlineSpinner size="sm" label={t("gallery.map.tray.loading")} />}
      {groups && groups.length === 0 && total === 0 && <EmptyState compact title={t("gallery.map.tray.empty")} />}
      {groups && (
        <ul className="divide-y divide-line" aria-label={t("gallery.map.tray.title")}>
          {groups.map((g, i) => (
            <li key={g.key}>
              {g.tripId !== groups[i - 1]?.tripId && (
                <h3 className="break-words pt-3 pb-1 text-footnote font-semibold text-muted">
                  {g.tripId
                    ? `${g.tripName} ${t("gallery.map.tray.inTrip", { count: g.tripCount, formatted: formatNumber(g.tripCount) })}`
                    : t("gallery.map.tray.noTrip")}
                </h3>
              )}
              <GroupRow
                group={g}
                pinDown={pinDown}
                busy={busy}
                note={notes(g)}
                source={(ticked) => groupSource(g, ticked)}
                loadPhotos={() => photosOf(g)}
                onPlace={onPlace}
                onDragSource={onDragSource}
              />
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button
          variant="secondary"
          size="sm"
          loading={loadingMore}
          onClick={() => {
            setLoadingMore(true);
            loadMore(cursor)
              .catch((err) => setError(errorMessage(err, t("gallery.map.loadFailed"))))
              .finally(() => setLoadingMore(false));
          }}
        >
          {t("gallery.map.showMore")}
        </Button>
      )}
    </div>
  );
}

function GroupRow({
  group: g,
  pinDown,
  busy,
  note,
  source,
  loadPhotos,
  onPlace,
  onDragSource,
}: {
  group: PlacingGroup;
  loadPhotos: () => Promise<{ captureIds: string[]; photoIds: string[] }>;
  pinDown: boolean;
  busy: boolean;
  note: string | null;
  source: (ticked?: string[]) => PlaceSource;
  onPlace: (source: PlaceSource) => void;
  onDragSource: (source: PlaceSource | null) => void;
}) {
  const { t } = useTranslation();
  const [photos, setPhotos] = useState<{ captureIds: string[]; photoIds: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const lastClicked = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Select mode, as in the Gallery: ticks show and a click toggles only after Select (or a
  // Cmd or Shift-click); otherwise a click previews the photo.
  const [selecting, setSelecting] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const selectMenu = useDropdownMenu();
  const leaveSelect = () => {
    setSelecting(false);
    setTicked(new Set());
  };
  useEscapeToClose(() => (ticked.size > 0 ? setTicked(new Set()) : setSelecting(false)), selecting && viewing === null);
  const count = { count: g.count, formatted: formatNumber(g.count) };
  const when = g.from
    ? t("gallery.map.tray.group", {
        ...count,
        date: formatDate(g.from, "medium"),
      })
    : t("gallery.map.tray.groupNoDate", count);
  const times = g.from && g.to && g.from !== g.to ? formatDateSpan(g.from, g.to, "time") : null;
  const chosen = [...ticked];
  const placeCount = chosen.length || g.count;

  function toggle(index: number, shift: boolean) {
    if (!photos) return;
    const next = new Set(ticked);
    const on = !next.has(photos.captureIds[index]);
    const from = shift && lastClicked.current !== null ? Math.min(lastClicked.current, index) : index;
    const to = shift && lastClicked.current !== null ? Math.max(lastClicked.current, index) : index;
    for (let i = from; i <= to; i++) {
      if (on) next.add(photos.captureIds[i]);
      else next.delete(photos.captureIds[i]);
    }
    lastClicked.current = index;
    setTicked(next);
  }

  async function fetchPhotos() {
    if (photos) return photos;
    try {
      const res = await loadPhotos();
      setPhotos(res);
      return res;
    } catch (err) {
      setError(errorMessage(err, t("gallery.map.loadFailed")));
      return null;
    }
  }
  async function expand() {
    setOpen(!open);
    if (!open) await fetchPhotos();
  }
  // A cover in the row's stack opens the viewer on that photo, with the group's others beside it.
  async function preview(photoId: string) {
    const res = await fetchPhotos();
    if (res) setViewing(Math.max(0, res.photoIds.indexOf(photoId)));
  }
  const slides = (photos?.photoIds ?? []).map((id, i) => ({
    url: `/api/photos/${id}/display`,
    captureId: photos!.captureIds[i],
    caption: when,
  }));

  return (
    <div
      draggable={!busy}
      onDragStart={(e) => {
        // The viewer is portalled but its events still bubble here; only the row itself drags.
        if (!e.currentTarget.contains(e.target as Node)) return;
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("text/plain", when);
        onDragSource(source(chosen));
      }}
      onDragEnd={() => onDragSource(null)}
      className="py-2"
      data-testid="placing-group"
    >
      <div className="flex items-start gap-2">
        <div className="grid w-14 shrink-0 grid-cols-2 gap-0.5">
          {g.coverPhotoIds.map((id, i) => (
            // raw-control: the thumbnail itself is the preview button, like a photo tile.
            <button
              key={id}
              type="button"
              aria-label={t("gallery.map.tray.preview", { index: i + 1 })}
              onClick={() => void preview(id)}
              className={`block rounded-badge focus-visible:outline-2 focus-visible:outline-accent ${g.coverPhotoIds.length === 1 ? "col-span-2" : ""}`}
            >
              <ProgressiveImg
                thumbSrc={`/api/photos/${id}/thumb`}
                alt=""
                className="aspect-square w-full cursor-pointer rounded-badge object-cover"
              />
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-callout text-ink">{when}</p>
          {(times || g.regionName) && (
            <p className="break-words text-footnote text-muted">{[times, g.regionName].filter(Boolean).join(", ")}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              tooltip={pinDown ? undefined : { label: t("gallery.map.tray.placeHint") }}
              onClick={() => onPlace(source(chosen))}
            >
              {pinDown
                ? t("gallery.map.placing.place", { count: placeCount, formatted: formatNumber(placeCount) })
                : t("gallery.map.tray.place")}
            </Button>
            <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => void expand()}>
              {open ? t("gallery.map.tray.hidePhotos") : t("gallery.map.tray.showPhotos")}
            </Button>
          </div>
          {pinDown && note && <p className="mt-1 break-words text-footnote text-muted">{note}</p>}
        </div>
      </div>
      <FormMessage error={error} />
      {open && photos && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {!selecting ? (
              <Button variant="secondary" size="sm" onClick={() => setSelecting(true)}>
                {t("ui.select")}
              </Button>
            ) : (
              <>
                <Menu
                  open={selectMenu.openKey !== null}
                  onToggle={() => selectMenu.setOpenKey(selectMenu.openKey ? null : true)}
                  menuRef={selectMenu.ref}
                  className="relative"
                  trigger={(props) => (
                    <Button {...props} variant="secondary" size="sm">
                      {t("ui.select")}
                    </Button>
                  )}
                >
                  <MenuPanel>
                    <MenuItems
                      items={[
                        { label: t("gallery.map.selectAll"), onSelect: () => setTicked(new Set(photos.captureIds)) },
                        {
                          label: t("gallery.map.deselectAll"),
                          onSelect: () => setTicked(new Set()),
                          disabled: ticked.size === 0,
                        },
                      ]}
                    />
                  </MenuPanel>
                </Menu>
                <Button variant="secondary" size="sm" onClick={leaveSelect}>
                  {t("common.done")}
                </Button>
              </>
            )}
          </div>
          <div
            className="grid grid-cols-4 gap-1"
            // Cmd or Shift-click on a photo enters select mode with it ticked, as in the Gallery.
            onClickCapture={(e) => {
              if (selecting || !(e.metaKey || e.ctrlKey || e.shiftKey)) return;
              const tile = (e.target as HTMLElement).closest("[data-index]");
              if (!tile) return;
              e.preventDefault();
              e.stopPropagation();
              setSelecting(true);
              toggle(Number(tile.getAttribute("data-index")), false);
            }}
          >
            {photos.captureIds.map((id, i) => (
              <div key={id} data-index={i}>
                <PhotoTile
                  photoId={photos.photoIds[i]}
                  alt=""
                  aspectRatio={1}
                  onOpen={() => setViewing(i)}
                  selectMode={selecting}
                  selected={ticked.has(id)}
                  onToggleSelect={(shift) => toggle(i, shift)}
                  menuOpen={false}
                  onToggleMenu={() => {}}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {viewing !== null && slides[viewing] && (
        <Lightbox slides={slides} index={viewing} onIndexChange={setViewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
