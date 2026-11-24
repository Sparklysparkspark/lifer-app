import { useCallback, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import EmptyState from "../../components/EmptyState";
import PhotoGrid, { type PhotoGridMenu } from "../../components/PhotoGrid";
import PhotoTileCaption from "../../components/PhotoTileCaption";
import TextField from "../../components/TextField";
import Button from "../../components/Button";
import { versionName } from "../../lib/photoVersions";
import { useGoBack } from "../../hooks/useGoBack";
import PhotosIcon from "../../components/PhotosIcon";
import { useSpeciesName } from "../../lib/speciesName";
import { groupGalleryItems, itemShotData, type GalleryGroupBy } from "./galleryHelpers";
import type { GalleryDisplayPrefs } from "./useGalleryDisplayPrefs";
import type { GalleryItem } from "./types";
import type { BurstInfo } from "./useGalleryBursts";

const galleryId = (item: GalleryItem) => item.captureId;

// The photo grid. Grouping stacks one justified block per group; `i` is always the index into the
// flat `items` array, so grouped tiles open and select the same way as ungrouped ones.
export default function GalleryGrid({
  items,
  display,
  groupBy,
  namingStyles,
  missingDate,
  selectMode,
  selectedIds,
  dragPreviewIds,
  menu,
  renderMenu,
  savingDateCaptureId,
  onOpen,
  onToggleSelect,
  onDragStart,
  onDragEnter,
  onRate,
  onSetTakenAt,
  onShowPhoto,
  bursts,
}: {
  items: GalleryItem[];
  display: GalleryDisplayPrefs;
  groupBy: GalleryGroupBy;
  namingStyles: string[];
  missingDate: boolean;
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  dragPreviewIds: ReadonlySet<string> | null;
  menu: PhotoGridMenu;
  renderMenu: (item: GalleryItem) => ReactNode;
  savingDateCaptureId: string | null;
  onOpen: (index: number) => void;
  onToggleSelect: (captureId: string, index: number, shiftKey: boolean) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onRate: (captureId: string, rating: number | null) => void;
  onSetTakenAt: (captureId: string, value: string) => void;
  /** A version's link back to the photo it belongs to (group capture id). */
  onShowPhoto?: (captureId: string) => void;
  /** The loaded photos' bursts, for the "+N" badge. */
  bursts?: ReadonlyMap<string, BurstInfo>;
}) {
  const { t } = useTranslation();
  const { showCameraInfo, showLabels, showRatings } = display;
  const speciesName = useSpeciesName();
  const shotLines = useMemo(() => new Map(items.map((it) => [it.photoId, itemShotData(it)])), [items]);
  const groups = useMemo(() => groupGalleryItems(items, groupBy, namingStyles), [items, groupBy, namingStyles]);
  // Stable, so a selection or menu change only re-renders the tiles it touches.
  const dragProps = useMemo(
    () => ({ onDragSelectStart: onDragStart, onDragSelectEnter: onDragEnter }),
    [onDragStart, onDragEnter],
  );
  const tileFor = useCallback(
    (item: GalleryItem) => ({
      ...item,
      alt: speciesName(item),
      versionLabel: item.version ? versionName(t, item.version) : undefined,
      burstCount: bursts?.get(item.captureId)?.count,
    }),
    [speciesName, t, bursts],
  );
  const renderLabel = useCallback(
    (item: GalleryItem) => (
      <>
        <PhotoTileCaption
          showLabels={showLabels}
          showRatings={showRatings}
          showCameraInfo={showCameraInfo}
          label={speciesName(item)}
          rating={item.qualityRating}
          onRate={(rating) => onRate(item.captureId, rating)}
          shotLine={showCameraInfo ? (shotLines.get(item.photoId) ?? null) : null}
        />
        {item.version && onShowPhoto && (
          <Button variant="link" size="sm" onClick={() => onShowPhoto(item.version!.of)}>
            {t("versions.showPhoto")}
          </Button>
        )}
        {missingDate && (
          <TextField
            type="date"
            disabled={savingDateCaptureId === item.captureId}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => e.target.value && onSetTakenAt(item.captureId, e.target.value)}
            className="mt-1"
            size="sm"
          />
        )}
      </>
    ),
    [
      showLabels,
      showRatings,
      showCameraInfo,
      speciesName,
      onRate,
      shotLines,
      missingDate,
      savingDateCaptureId,
      onSetTakenAt,
      onShowPhoto,
      t,
    ],
  );

  return (
    <PhotoGrid
      items={items}
      idFor={galleryId}
      tileFor={tileFor}
      columnWidth={display.thumbSizePx}
      gap={display.gridGapPx}
      cornerRadiusPx={display.gridCornerRadiusPx}
      groups={groups}
      select={{ selectMode, selectedIds, dragPreviewIds, toggle: onToggleSelect, dragProps }}
      menu={menu}
      renderMenu={renderMenu}
      renderLabel={renderLabel}
      onOpen={onOpen}
    />
  );
}

// Why the grid is empty, and the way out.
export function GalleryEmptyState({
  missingDate,
  libraryEmpty,
  searchQuery,
  activeFilterCount,
  onClearFilters,
  onClearSearch,
}: {
  missingDate: boolean;
  libraryEmpty: boolean;
  searchQuery: string;
  activeFilterCount: number;
  onClearFilters: () => void;
  /** Clears the search alone; the filters stay. */
  onClearSearch: () => void;
}) {
  const { t } = useTranslation();
  const goBack = useGoBack();
  const navigate = useNavigate();
  if (missingDate)
    return (
      <EmptyState
        icon={<PhotosIcon />}
        title={t("gallery.empty.allDated")}
        description={t("gallery.empty.allDatedBody")}
        action={{ label: t("gallery.empty.backToStats"), onClick: () => goBack("/stats") }}
      />
    );
  if (libraryEmpty && !searchQuery) {
    return (
      <EmptyState
        icon={<PhotosIcon />}
        title={t("gallery.empty.noPhotos")}
        description={t("gallery.empty.noPhotosBody")}
        action={{ label: t("nav.importPhotos"), onClick: () => navigate("/import") }}
      />
    );
  }
  if (searchQuery) {
    return (
      <EmptyState
        icon={<PhotosIcon />}
        title={t("gallery.empty.noSearchMatch", { query: searchQuery })}
        description={t("gallery.empty.noSearchMatchBody")}
        action={{ label: t("gallery.empty.clearSearch"), onClick: onClearSearch }}
        secondaryAction={
          activeFilterCount > 0 ? { label: t("gallery.empty.clearFilters"), onClick: onClearFilters } : undefined
        }
      />
    );
  }
  const onlyPresets = activeFilterCount === 0;
  return (
    <EmptyState
      icon={<PhotosIcon />}
      title={t("gallery.empty.noFilterMatch")}
      description={onlyPresets ? t("gallery.empty.presetsBody") : t("gallery.empty.filtersBody")}
      action={{
        label: onlyPresets ? t("gallery.empty.showAll") : t("gallery.empty.clearFilters"),
        onClick: onClearFilters,
      }}
    />
  );
}
