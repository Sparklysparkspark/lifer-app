import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { errorMessage } from "../../lib/errorMessage";
import { formatNumber } from "../../lib/format";
import { useSpeciesName } from "../../lib/speciesName";
import Button from "../Button";
import FormMessage from "../FormMessage";
import InlineSpinner from "../InlineSpinner";
import { MarkPhotoViewer, useMarkPhotos } from "./MapPhotoViewer";
import Menu, { MenuItems, MenuPanel, type MenuAction } from "../Menu";
import PhotoTile from "../PhotoTile";

/** The photos at a clicked dot, cluster, ring or spot, best rated first, without leaving the map. */
export default function MapPhotoPanel({
  params,
  actions,
  onOpenInGallery,
  onChanged,
}: {
  /** The Gallery's filters plus the selection's own (bbox, regionId or place). */
  params: URLSearchParams;
  /** The overflow menu. */
  actions: MenuAction[];
  onOpenInGallery: () => void;
  /** After an edit from the viewer, so the map's dots follow. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const menu = useDropdownMenu();
  const photos = useMarkPhotos(params);
  const { items, cursor, total } = photos;
  const loadError = photos.error ? errorMessage(photos.error, t("gallery.map.loadFailed")) : null;

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
            photos
              .loadMore()
              .catch((err) => setError(errorMessage(err, t("gallery.map.loadFailed"))))
              .finally(() => setLoadingMore(false));
          }}
        >
          {t("gallery.map.showMore")}
        </Button>
      )}
      {open !== null && (
        <MarkPhotoViewer
          photos={photos}
          index={open}
          onIndexChange={setOpen}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}
