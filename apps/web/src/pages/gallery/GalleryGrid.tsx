import { useMemo, type ReactNode, type RefObject } from "react";
import MasonryGrid from "../../components/MasonryGrid";
import EmptyState from "../../components/EmptyState";
import PhotosIcon from "../../components/PhotosIcon";
import { estimateShotDataWrapExtraPx } from "../../lib/shotData";
import GalleryTile from "./GalleryTile";
import { groupItemsByRegion, itemShotData } from "./galleryHelpers";
import { CAMERA_INFO_LINE_HEIGHT_PX, type GalleryDisplayPrefs } from "./useGalleryDisplayPrefs";
import type { ContextAnchor, GalleryItem } from "./types";

const EMPTY_SET: ReadonlySet<string> = new Set();

type Entry = { item: GalleryItem; i: number };

// The photo grid. Grouping stacks one MasonryGrid per region; a single grid can't splice headers
// in without breaking column alignment.
export default function GalleryGrid({
  items,
  display,
  missingDate,
  selectMode,
  selectedIds,
  dragPreviewIds,
  openMenuKey,
  menuRef,
  contextMenuAnchor,
  renderMenu,
  savingDateCaptureId,
  onOpen,
  onToggleSelect,
  onDragStart,
  onDragEnter,
  onToggleMenu,
  onOpenContextMenu,
  onRate,
  onSetTakenAt,
}: {
  items: GalleryItem[];
  display: GalleryDisplayPrefs;
  missingDate: boolean;
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  dragPreviewIds: ReadonlySet<string> | null;
  openMenuKey: string | null;
  menuRef: RefObject<HTMLDivElement | null>;
  contextMenuAnchor: ContextAnchor | null;
  renderMenu: (item: GalleryItem) => ReactNode;
  savingDateCaptureId: string | null;
  onOpen: (index: number) => void;
  onToggleSelect: (captureId: string, index: number, shiftKey: boolean) => void;
  onDragStart: (index: number) => void;
  onDragEnter: (index: number) => void;
  onToggleMenu: (photoId: string) => void;
  onOpenContextMenu: (photoId: string, point: { x: number; y: number }) => void;
  onRate: (captureId: string, rating: number | null) => void;
  onSetTakenAt: (captureId: string, value: string) => void;
}) {
  const { showCameraInfo, showLabels, showRatings } = display;
  const shotLines = useMemo(() => new Map(items.map((it) => [it.photoId, itemShotData(it)])), [items]);
  // `i` is always the index into the flat `items` array, so grouped tiles open and select the
  // same way as ungrouped ones.
  const regionGroups = useMemo(() => groupItemsByRegion(items), [items]);
  const flatEntries = useMemo(() => items.map((item, i) => ({ item, i })), [items]);
  const extraHeightPxFor = useMemo(
    () =>
      showCameraInfo
        ? ({ item }: Entry, columnWidthPx: number) =>
            estimateShotDataWrapExtraPx(shotLines.get(item.photoId) ?? null, columnWidthPx, CAMERA_INFO_LINE_HEIGHT_PX)
        : undefined,
    [showCameraInfo, shotLines],
  );
  const previewIds = dragPreviewIds ?? EMPTY_SET;

  function renderGrid(entries: Entry[]) {
    return (
      <MasonryGrid
        items={entries}
        columnWidth={display.thumbSizePx}
        gap={display.gridGapPx}
        extraHeightPx={display.extraHeightPx}
        extraHeightPxFor={extraHeightPxFor}
        keyFor={({ item }) => item.photoId}
        aspectRatioFor={({ item }) => (item.width && item.height ? item.width / item.height : null)}
        renderItem={({ item, i }, aspectRatio) => {
          const menuOpen = openMenuKey === item.photoId;
          return (
            <GalleryTile
              key={item.photoId}
              item={item}
              index={i}
              aspectRatio={aspectRatio}
              cornerRadiusPx={display.gridCornerRadiusPx}
              selectMode={selectMode}
              selected={selectedIds.has(item.captureId) || previewIds.has(item.captureId)}
              menuOpen={menuOpen}
              contextMenuAnchor={contextMenuAnchor?.photoId === item.photoId ? contextMenuAnchor : null}
              menuContent={menuOpen ? renderMenu(item) : null}
              menuRef={menuRef}
              shotLine={showCameraInfo ? (shotLines.get(item.photoId) ?? null) : null}
              showLabels={showLabels}
              showRatings={showRatings}
              showCameraInfo={showCameraInfo}
              missingDate={missingDate}
              savingDate={savingDateCaptureId === item.captureId}
              onOpen={onOpen}
              onToggleSelect={onToggleSelect}
              onDragStart={onDragStart}
              onDragEnter={onDragEnter}
              onToggleMenu={onToggleMenu}
              onOpenContextMenu={onOpenContextMenu}
              onRate={onRate}
              onSetTakenAt={onSetTakenAt}
            />
          );
        }}
      />
    );
  }

  if (!display.groupByRegion) return renderGrid(flatEntries);
  return (
    <div className="space-y-8">
      {regionGroups.map((group) => (
        <section key={group.key}>
          <h2 className="mb-2 text-sm font-semibold text-ink">{group.label}</h2>
          {renderGrid(group.entries)}
        </section>
      ))}
    </div>
  );
}

// Why the grid is empty, and the way out.
export function GalleryEmptyState({
  missingDate,
  libraryEmpty,
  searchQuery,
  activeFilterCount,
  onClearFilters,
}: {
  missingDate: boolean;
  libraryEmpty: boolean;
  searchQuery: string;
  activeFilterCount: number;
  onClearFilters: () => void;
}) {
  if (missingDate) return <p className="text-muted">Every photo has a date. Nothing to fix here.</p>;
  if (libraryEmpty && !searchQuery) {
    return (
      <EmptyState
        icon={<PhotosIcon />}
        title="No photos yet"
        description="Upload one from a species page to get started."
      />
    );
  }
  if (searchQuery) {
    return (
      <EmptyState
        icon={<PhotosIcon />}
        title={`No photos match "${searchQuery}"`}
        description="Try different words, or clear the search and filters."
        action={{ label: "Clear search and filters", onClick: onClearFilters }}
      />
    );
  }
  const onlyPresets = activeFilterCount === 0;
  return (
    <EmptyState
      icon={<PhotosIcon />}
      title="No photos match these filters"
      description={
        onlyPresets ? "Gallery shows photos without RAW files by default." : "Loosen or clear the filters to see more."
      }
      action={{ label: onlyPresets ? "Show all photos" : "Clear filters", onClick: onClearFilters }}
    />
  );
}
