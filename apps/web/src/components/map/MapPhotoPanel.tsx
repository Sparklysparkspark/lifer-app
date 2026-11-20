import { useMemo, useState } from "react";
import { useApiRoute } from "../../lib/resource";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useLatest } from "../../hooks/useLatest";
import { errorMessage } from "../../lib/errorMessage";
import { formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import type { GalleryItem } from "../../pages/gallery/types";
import Button from "../Button";
import FormMessage from "../FormMessage";
import InlineSpinner from "../InlineSpinner";
import Lightbox, { type LightboxSlide } from "../Lightbox";
import { gallerySlide } from "./gallerySlide";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "../Menu";
import PhotoTile from "../PhotoTile";

const PAGE = 60;

/** The photos at a clicked dot, cluster, ring or spot, best rated first, without leaving the map.
 *  Pages through /gallery, so a 20,000-photo cluster never loads all at once. */
export default function MapPhotoPanel({
  params,
  actions,
  onOpenInGallery,
}: {
  /** The Gallery's filters plus the selection's own (bbox, regionId or place). */
  params: URLSearchParams;
  /** The overflow menu. */
  actions: MenuAction[];
  onOpenInGallery: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const menu = useDropdownMenu();
  const firstParams = new URLSearchParams(params);
  firstParams.set("sort", "ratingHigh");
  firstParams.set("limit", String(PAGE));
  const first = useApiRoute(apiPath("/gallery", {}, firstParams));
  // Later pages and rating edits, kept only while they follow the first page they were made on.
  const [more, setMore] = useState<{ after: object | null; items: GalleryItem[]; cursor: string | null }>({
    after: null,
    items: [],
    cursor: null,
  });
  const extra = first.data && more.after === first.data ? more : null;
  const items = first.data ? (extra ? extra.items : first.data.items) : null;
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);
  const total = first.data ? (first.data.total ?? first.data.items.length) : null;
  const loadError = first.error ? errorMessage(first.error, t("gallery.map.loadFailed")) : null;
  const setItems = (update: (prev: GalleryItem[]) => GalleryItem[], next = cursor) =>
    first.data && setMore({ after: first.data, items: update(items ?? []), cursor: next });

  async function loadMore(next: string) {
    const p = new URLSearchParams(firstParams);
    p.set("cursor", next);
    const res = await api.get(apiPath("/gallery", {}, p));
    setItems((prev) => [...prev, ...res.items], res.nextCursor);
  }

  const rate = useLatest((captureId: string, rating: number | null) => {
    setItems((prev) => prev.map((it) => (it.captureId === captureId ? { ...it, qualityRating: rating } : it)));
    api
      .patch(apiPath("/captures/{id}/rating", { id: captureId }), { rating })
      .catch((err) => setError(errorMessage(err, t("gallery.map.rateFailed"))));
  });
  const slides = useMemo<LightboxSlide[]>(
    () => (items ?? []).map((i) => gallerySlide(i, speciesName, (rating) => rate.current(i.captureId, rating))),
    [items, speciesName, rate],
  );

  return (
    <div className="space-y-3" data-testid="map-photo-panel">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-footnote text-muted">
          {total !== null && t("gallery.map.photoCount", { count: total, formatted: formatNumber(total) })}
        </p>
        <Button variant="secondary" size="sm" onClick={onOpenInGallery}>
          {t("gallery.map.openInGallery")}
        </Button>
        {actions.length > 0 && (
          <Menu
            open={menu.openKey === true}
            onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
            menuRef={menu.ref}
            className="relative shrink-0"
            trigger="toolbar"
          >
            <MenuPanel className="right-0 whitespace-nowrap">
              <MenuItems items={actions} />
            </MenuPanel>
          </Menu>
        )}
      </div>
      <FormMessage error={error ?? loadError} />
      {!items && !loadError && <InlineSpinner size="sm" label={t("gallery.map.tray.loading")} />}
      {items && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-1">
          {items.map((it, i) => (
            <div key={it.captureId} className="relative">
              <PhotoTile
                photoId={it.photoId}
                alt={speciesName(it)}
                kind={it.kind === "video" ? "video" : it.kind === "audio" ? "audio" : "image"}
                aspectRatio={1}
                onOpen={() => setOpen(i)}
                selectMode={false}
                selected={false}
                onToggleSelect={() => {}}
                menuOpen={false}
                onToggleMenu={() => {}}
              />
              {/* A ring's photo in a cluster's list: it has only a region. */}
              {(it.lat === null || it.lon === null) && (
                <span className="pointer-events-none absolute bottom-1 left-1 max-w-[calc(100%-0.5rem)] truncate rounded-badge bg-surface px-1 text-caption text-ink">
                  {t("gallery.map.card.noExactTag")}
                </span>
              )}
            </div>
          ))}
        </div>
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
      {open !== null && slides[open] && (
        <Lightbox slides={slides} index={open} onIndexChange={setOpen} onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
