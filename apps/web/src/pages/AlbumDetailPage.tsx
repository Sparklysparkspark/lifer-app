import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LoadingScreen, Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import PhotoImportRows from "../components/PhotoImportRows";
import SpeciesCard from "../components/SpeciesCard";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import { photoFilePaths } from "../lib/photoFilePaths";
import CardCropEditor from "../components/CardCropEditor";
import { NAME_MAX_LENGTH } from "@lifer/shared";
import EditableTextField from "../components/EditableTextField";
import EmptyState from "../components/EmptyState";
import PhotosIcon from "../components/PhotosIcon";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { usePhotoGridSize } from "../hooks/usePhotoGridSize";
import { usePhotoCaptionPrefs } from "../hooks/usePhotoCaptionPrefs";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import Menu, { MenuItem, MenuLink, MenuPanel, MenuSeparator } from "../components/Menu";
import { buttonClasses } from "../lib/buttonClasses";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { PhotoViewMenu } from "../components/PhotoGridControls";
import PhotoFiltersMenu from "../components/PhotoFiltersMenu";
import { GRID_PHOTO_FILTER_SECTIONS, PHOTO_SORTS } from "../lib/photoGridSections";
import SelectModeToggle from "../components/SelectModeToggle";
import { useSelectMode } from "../hooks/useSelectMode";
import Button, { IconButton } from "../components/Button";
import { matchesMediaFilter, matchesPhotoFilters, sortPhotos } from "../lib/photoListFilters";
import { useGalleryFilters } from "./gallery/useGalleryFilters";
import { useGalleryFacets } from "./gallery/useGalleryFacets";
import { useScopedFilterIds } from "./gallery/useScopedFilterIds";
import { useApiResource } from "../lib/resource";
import type { AlbumView } from "./album/types";
import { useAlbumDetail } from "./album/useAlbumDetail";
import { useAlbumShares } from "./album/useAlbumShares";
import AlbumSharePanel from "./album/AlbumSharePanel";
import AlbumCoverEditor from "./album/AlbumCoverEditor";
import AlbumPhotoGrid from "./album/AlbumPhotoGrid";
import ExportAlbumModal from "./album/ExportAlbumModal";
import SmartAlbumBuilder from "./album/SmartAlbumBuilder";
import AlbumExclusionsModal from "./album/AlbumExclusionsModal";
import SmartAlbumLabel from "../components/SmartAlbumLabel";
import { useRulesSummary } from "./gallery/smartAlbumRules";
import { useSpeciesName } from "../lib/speciesName";
import { backStateFor } from "../lib/backLabel";
import { docsUrl } from "../lib/docs";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useSearchParamsKeepingState, useUrlParam } from "../hooks/useSearchParamsKeepingState";
import type { ComparePhoto } from "../components/CompareView";
import { api, apiPath } from "../api/client";
import Tip from "../components/Tip";
import { errorMessage } from "../lib/errorMessage";

// Loaded when photos are first compared.
const CompareView = lazy(() => import("../components/CompareView"));

// The album's own saved browsing presets, apart from the Gallery's.
const ALBUM_PRESET_KEYS = {
  rawFiles: "albumRawFiles",
  editedRaw: "albumEditedRaw",
  media: "albumMediaFilter",
  sort: "albumSortBy",
};

const SPECIES_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-6 w-6 text-muted"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

// The standard share symbol: a box with an arrow leaving it.
const SHARE_ICON = (
  <svg
    viewBox="0 0 24 24"
    className="h-4 w-4"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3v12M8 7l4-4 4 4M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" />
  </svg>
);

export default function AlbumDetailPage() {
  const speciesName = useSpeciesName();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [compareIds, setCompareIds] = useState<string[] | null>(null);
  const [thumbSizePx, setThumbSizePx] = usePhotoGridSize();
  const captions = usePhotoCaptionPrefs();
  // The Gallery's filters. The whole album loads at once, so sorting and most filters run here;
  // the rest ask the Gallery's own query for the matching photos. Unrated sorts as 3.
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();
  const filters = useGalleryFilters(searchParams, setSearchParams, undefined, {
    keys: ALBUM_PRESET_KEYS,
    search: false,
  });
  const { query } = filters;
  const { sortBy, mediaFilter, rawFiles, editedRaw, ratingMin, ratingMax, unrated, missingDate, dateFrom, dateTo } =
    query;
  const facets = useGalleryFacets();
  const tagOptions = useApiResource<{ tags: string[] }>("/captures/tags").data?.tags ?? [];
  const serverMatches = useScopedFilterIds(id ? { albumId: id } : null, query);
  const menu = useDropdownMenu<string>();
  const moreMenu = useDropdownMenu();
  const confirm = useConfirm();
  const toast = useToast();
  const isServerMode = useDeploymentMode() === "server";
  // In the URL so returning from a species opened here lands on the same view.
  const [viewParam, setViewParam] = useUrlParam("view");
  const view: AlbumView = viewParam === "species" ? "species" : "gallery";
  const setView = (next: AlbumView) => setViewParam(next === "species" ? next : "");
  const [croppingCoverPhotoUrl, setCroppingCoverPhotoUrl] = useState<string | null>(null);
  // Cover controls and the edit toolbar stay hidden until asked for, keeping the grid uncluttered.
  const [editMode, setEditMode] = useState(false);
  // Imports link new captures into the album; files stay wherever the library stores them.
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Which quad tile (0-3) is mid pick-a-photo or crop; only one at a time.
  const [pickingQuadSlot, setPickingQuadSlot] = useState<number | null>(null);
  // A photo chosen as cover while the cover is a quad grid: the user picks which tile it replaces.
  const [replacingWith, setReplacingWith] = useState<string | null>(null);
  const [croppingQuadSlot, setCroppingQuadSlot] = useState<number | null>(null);
  const shares = useAlbumShares(id);
  const detail = useAlbumDetail(id, view);
  const { album } = detail;
  // A smart album's rules choose its photos: edited in the rule builder, with hand exclusions.
  const [editingRules, setEditingRules] = useState(false);
  const [showingExcluded, setShowingExcluded] = useState(false);
  const rulesSummary = useRulesSummary(album?.rules);
  // Arriving from New album opens with its name selected, once: the flag is cleared from history
  // so a reload or a later visit back doesn't do it again.
  const [justCreated] = useState(() => !!(location.state as { justCreated?: boolean } | null)?.justCreated);
  useEffect(() => {
    if (!justCreated) return;
    navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true, state: { ...(location.state as object), justCreated: false } },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on arrival only
  }, []);

  // Slides and the grid both derive from this array so the shared lightbox index stays correct.
  const sortedItems = useMemo(() => {
    if (!album) return [];
    return sortPhotos(album.items, sortBy).filter(
      (item) =>
        (!serverMatches || serverMatches.has(item.captureId)) &&
        matchesMediaFilter(item.kind, mediaFilter) &&
        matchesPhotoFilters(
          item,
          { hasRaw: !!item.hasRawOriginal, rawOnly: item.originalKind === "raw" },
          { rawFiles, editedRaw, ratingMin, ratingMax, unrated, missingDate, dateFrom, dateTo },
        ),
    );
  }, [
    album,
    serverMatches,
    sortBy,
    mediaFilter,
    rawFiles,
    editedRaw,
    ratingMin,
    ratingMax,
    unrated,
    missingDate,
    dateFrom,
    dateTo,
  ]);
  const select = useSelectMode(sortedItems, (item) => item.captureId);
  function stopEditing() {
    setEditMode(false);
    setPickingQuadSlot(null);
    setReplacingWith(null);
  }
  async function deleteAlbum() {
    const ok = await confirm({
      title: t("albums.delete.title"),
      message: t("albums.delete.body"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (ok && (await detail.deleteAlbum())) {
      toast.success(t("albums.delete.done"));
      navigate("/albums", { replace: true });
    }
  }
  const { selectMode } = select;
  useScrollMemory(!!album);

  function chooseCover(photoId: string | null) {
    menu.setOpenKey(null);
    if (photoId && album?.coverLayout === "quad") {
      setPickingQuadSlot(null);
      setReplacingWith(photoId);
      setEditMode(true);
      return;
    }
    return detail.setCoverPhoto(photoId);
  }
  async function featurePhoto(photo: ComparePhoto) {
    const speciesId = album?.items.find((i) => i.captureId === photo.captureId)?.speciesId;
    if (!speciesId) return;
    try {
      await api.patch(apiPath("/species/{id}/cover", { id: speciesId }), { photoId: photo.photoId });
      toast.success(t("compare.featuredToast"));
    } catch (err) {
      toast.error(errorMessage(err, t("compare.featureFailed")));
    }
  }

  if (detail.loadError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-muted">{t("albums.detail.loadFailed")}</p>
        <Button variant="secondary" size="sm" onClick={detail.load}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }
  if (!album) return <LoadingScreen />;

  const hasVideoInAlbum = album.items.some((i) => i.kind !== "image");

  const slides: LightboxSlide[] = sortedItems.map((item) => ({
    url: `/api/photos/${item.photoId}/display`,
    videoUrl: item.kind === "video" ? `/api/photos/${item.photoId}/video` : null,
    audioUrl: item.kind === "audio" ? `/api/photos/${item.photoId}/audio` : null,
    frameUrl: item.kind === "video" ? `/photos/${item.photoId}/frame` : null,
    caption: speciesName(item),
    speciesId: item.speciesId,
    info: {
      cameraModel: item.cameraModel,
      lens: item.lens,
      focalLengthMm: item.focalLengthMm,
      aperture: item.aperture,
      shutter: item.shutter,
      iso: item.iso,
      durationSeconds: item.durationSeconds,
      files: photoFilePaths(item.originalRef, item.rawRef),
    },
  }));
  // The Gallery picker and species pages opened from here name the album on their back link.
  const backState = backStateFor(location, t, album.name);
  const croppingSlot = croppingQuadSlot != null ? album.quadSlots[croppingQuadSlot] : null;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={
          <EditableTextField
            value={album.name}
            onSave={detail.saveName}
            maxLength={NAME_MAX_LENGTH}
            autoSelect={justCreated}
            className="text-title-2 font-semibold text-ink"
          />
        }
        titleAddon={album.rules && <SmartAlbumLabel iconClassName="h-4.5 w-4.5" />}
        backFallbackTo="/albums"
        backLabel={t("nav.albums")}
        actions={
          <>
            {/* Editing shows its one way out where the menu that started it was. */}
            {editMode && (
              <Button size="sm" onClick={stopEditing}>
                {t("albums.detail.doneEditing")}
              </Button>
            )}
            <PhotoViewMenu
              sections={view === "gallery" ? ["show", "sort", "size", "captions"] : ["show"]}
              activeCount={view === "gallery" && sortBy !== "newest" ? 1 : 0}
              show={{ value: view, onChange: setView }}
              sort={{ value: sortBy, options: PHOTO_SORTS, onChange: filters.setSortBy }}
              size={{ value: thumbSizePx, onChange: setThumbSizePx }}
              captions={captions}
            />
            {/* Filters and Select act on photos, so the species view has neither. */}
            {view === "gallery" && album.items.length > 0 && (
              <>
                {/* Hidden photos never show in an album, so neither does their filter. */}
                <PhotoFiltersMenu
                  filters={filters}
                  facets={{ ...facets, hasOtherMediaInLibrary: hasVideoInAlbum, hiddenCount: 0 }}
                  tagOptions={tagOptions}
                  sections={GRID_PHOTO_FILTER_SECTIONS}
                />
                <SelectModeToggle active={selectMode} onEnter={() => select.setSelectMode(true)} onExit={select.exit} />
              </>
            )}
            {/* Desktop has no public URL to share, so the More menu explains instead. */}
            {isServerMode && (
              <IconButton
                onClick={shares.togglePanel}
                active={shares.showPanel}
                aria-label={shares.showPanel ? t("albums.detail.hideSharing") : t("albums.detail.share")}
                aria-expanded={shares.showPanel}
              >
                {SHARE_ICON}
              </IconButton>
            )}
            <Menu
              trigger="toolbar"
              open={moreMenu.openKey === true}
              onToggle={() => moreMenu.setOpenKey(moreMenu.openKey ? null : true)}
              menuRef={moreMenu.ref}
              className="relative"
            >
              <MenuPanel className="min-w-44 whitespace-nowrap">
                {!editMode && (
                  <MenuItem
                    onSelect={() => {
                      setEditMode(true);
                      setView("gallery");
                    }}
                  >
                    {t("albums.detail.edit")}
                  </MenuItem>
                )}
                {album.rules && (
                  <MenuItem onSelect={() => setEditingRules(true)}>{t("albums.smart.editRules")}</MenuItem>
                )}
                <MenuItem onSelect={() => setExporting(true)}>{t("albums.export.action")}</MenuItem>
                {!isServerMode && (
                  <MenuLink href={docsUrl("/install/connect-desktop-to-server")}>
                    {t("albums.detail.shareNeedsServer")}
                  </MenuLink>
                )}
                <MenuSeparator />
                <MenuItem danger onSelect={() => void deleteAlbum()}>
                  {t("albums.detail.delete")}
                </MenuItem>
              </MenuPanel>
            </Menu>
          </>
        }
      >
        {album.rules && (
          // One line: a long summary truncates (whole on hover) so the count is never pushed off.
          <div className="mt-0.5 flex min-w-0 items-baseline gap-x-1.5 text-callout text-muted">
            <Button
              variant="link"
              onClick={() => setEditingRules(true)}
              tooltip={{ label: t("albums.smart.matching", { rules: rulesSummary }) }}
              className="min-w-0"
            >
              <span className="truncate">{t("albums.smart.matching", { rules: rulesSummary })}</span>
            </Button>
            {album.excludedCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <Button variant="link" onClick={() => setShowingExcluded(true)} className="shrink-0 whitespace-nowrap">
                  {t("albums.smart.excludedCount", { count: album.excludedCount })}
                </Button>
              </>
            )}
          </div>
        )}
        <div className="mt-2 w-full">
          <EditableTextField
            value={album.description ?? ""}
            onSave={detail.saveDescription}
            placeholder={t("albums.detail.descriptionPlaceholder")}
            className="text-callout text-ink"
            multiline
          />
        </div>
      </PageHeader>

      {/* Edit mode's tools, apart from the header so the title keeps its room. Its one Done button is in the header. */}
      {editMode && (
        <div className="flex flex-wrap items-start gap-4 border-b border-line bg-surface px-page py-4">
          {/* Picking a quad tile's photo happens in the photo grid. */}
          {view === "gallery" && (
            <AlbumCoverEditor
              coverLayout={album.coverLayout}
              coverPhotoId={album.coverPhotoId}
              coverCrop={{ x: album.coverCropX, y: album.coverCropY, size: album.coverCropSize }}
              quadSlots={album.quadSlots}
              pickingSlot={pickingQuadSlot}
              replacingWith={replacingWith}
              onReplaceSlot={(slot) => {
                const photoId = replacingWith;
                setReplacingWith(null);
                if (photoId) void detail.setQuadSlotPhoto(slot, photoId);
              }}
              onCancelReplace={() => setReplacingWith(null)}
              onSetCoverLayout={detail.setCoverLayout}
              onCropCover={() => setCroppingCoverPhotoUrl(`/api/photos/${album.coverPhotoId}/display`)}
              onPickSlot={setPickingQuadSlot}
              onCropSlot={setCroppingQuadSlot}
            />
          )}
          {/* A smart album's rules add its photos. */}
          {!album.rules && (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/gallery?select=1&albumId=${album.id}`}
                state={backState}
                className={buttonClasses("secondary", "sm")}
              >
                {t("albums.detail.addPhotos")}
              </Link>
              <Button variant="secondary" size="sm" onClick={() => setShowImportPanel((v) => !v)}>
                {t("albums.detail.importAlbum")}
              </Button>
            </div>
          )}
        </div>
      )}

      <Tip id="smart-album" when={!!album.rules} className="mx-page mt-3" />

      {showImportPanel && id && (
        <div className="border-b border-line bg-surface-muted px-page py-4">
          <PhotoImportRows
            albumId={id}
            onImported={() => {
              detail.load();
              setShowImportPanel(false);
            }}
          />
        </div>
      )}

      {shares.showPanel && isServerMode && <AlbumSharePanel shares={shares} smart={!!album.rules} />}
      {exporting && <ExportAlbumModal albumId={album.id} albumName={album.name} onClose={() => setExporting(false)} />}
      {editingRules && (
        <SmartAlbumBuilder
          albumId={album.id}
          rules={album.rules}
          onClose={() => setEditingRules(false)}
          onSaved={() => {
            setEditingRules(false);
            toast.success(t("albums.smart.rulesSaved"));
            detail.load();
          }}
        />
      )}
      {showingExcluded && (
        <AlbumExclusionsModal albumId={album.id} onClose={() => setShowingExcluded(false)} onRestored={detail.load} />
      )}

      <main className="p-page">
        {album.items.length === 0 && album.rules ? (
          <EmptyState
            icon={<PhotosIcon />}
            title={t("albums.smart.empty.title")}
            description={t("albums.smart.empty.description")}
            action={{ label: t("albums.smart.editRules"), onClick: () => setEditingRules(true) }}
          />
        ) : album.items.length === 0 ? (
          // Add photos lives in Edit album; with nothing else on the page it's offered here too,
          // unless the edit toolbar already shows it.
          <EmptyState
            icon={<PhotosIcon />}
            title={t("albums.detail.empty.title")}
            description={t("albums.detail.empty.description")}
            action={
              editMode
                ? undefined
                : {
                    label: t("albums.detail.addPhotos"),
                    onClick: () => navigate(`/gallery?select=1&albumId=${album.id}`, { state: backState }),
                  }
            }
            secondaryAction={
              editMode ? undefined : { label: t("albums.detail.importAlbum"), onClick: () => setShowImportPanel(true) }
            }
          />
        ) : view === "species" ? (
          detail.speciesItems == null ? (
            <Spinner />
          ) : detail.speciesItems.length === 0 ? (
            <EmptyState
              icon={SPECIES_ICON}
              title={t("albums.detail.noSpecies.title")}
              description={t("albums.detail.noSpecies.description")}
            />
          ) : (
            <div className="grid grid-cols-2 gap-item sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {detail.speciesItems.map((item) => (
                <SpeciesCard key={item.speciesId} item={item} backLabel={album.name} />
              ))}
            </div>
          )
        ) : sortedItems.length === 0 ? (
          <EmptyState
            compact
            title={t("gallery.empty.noFilterMatch")}
            description={t("gallery.empty.filtersBody")}
            action={{ label: t("gallery.empty.clearFilters"), onClick: filters.clearFilters }}
          />
        ) : (
          <>
            <AlbumPhotoGrid
              items={sortedItems}
              select={select}
              thumbSizePx={thumbSizePx}
              captions={captions}
              onRate={(captureId, rating) => void detail.rateCapture(captureId, rating)}
              coverPhotoId={album.coverPhotoId}
              coverPicked={album.coverPicked}
              coverLayout={album.coverLayout}
              pickingQuadSlot={pickingQuadSlot}
              menu={menu}
              speciesLinkState={backState}
              onOpen={setLightboxIndex}
              onPickQuadPhoto={(slot, photoId) => {
                setPickingQuadSlot(null);
                return detail.setQuadSlotPhoto(slot, photoId);
              }}
              onSetCover={chooseCover}
              onCompare={setCompareIds}
              onAdjustCover={setCroppingCoverPhotoUrl}
              onRemove={detail.removeFromAlbum}
              onReload={detail.load}
              onUpdateItem={detail.updateItem}
              smart={!!album.rules}
            />
          </>
        )}
      </main>

      {compareIds && (
        <Suspense fallback={null}>
          <CompareView
            photos={compareIds.flatMap((id): ComparePhoto[] => {
              const item = album.items.find((i) => i.captureId === id);
              return item
                ? [
                    {
                      captureId: item.captureId,
                      photoId: item.photoId,
                      name: speciesName(item),
                      takenAt: item.takenAt,
                      detail: [item.cameraModel, item.lens].filter(Boolean).join(" · "),
                      rating: item.qualityRating ?? null,
                    },
                  ]
                : [];
            })}
            albumCoverPhotoId={album.coverPhotoId}
            onClose={() => setCompareIds(null)}
            onRate={(captureId, rating) => void detail.rateCapture(captureId, rating)}
            onFeature={(photo) => void featurePhoto(photo)}
            onSetAlbumCover={(photo) => {
              // A quad cover needs its tile picked on the page.
              if (album.coverLayout === "quad") setCompareIds(null);
              else toast.success(t("compare.coverToast"));
              chooseCover(photo.photoId);
            }}
          />
        </Suspense>
      )}

      {lightboxIndex !== null && (
        <Lightbox
          slides={slides}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
          backLabel={album.name}
        />
      )}

      {croppingCoverPhotoUrl && (
        <CardCropEditor
          photoUrl={croppingCoverPhotoUrl}
          initialX={album.coverCropX}
          initialY={album.coverCropY}
          initialSize={album.coverCropSize}
          onClose={() => setCroppingCoverPhotoUrl(null)}
          onSave={detail.saveCoverCrop}
          onReset={detail.resetCoverCrop}
        />
      )}

      {croppingQuadSlot != null && croppingSlot && (
        <CardCropEditor
          photoUrl={`/api/photos/${croppingSlot.photoId}/display`}
          initialX={croppingSlot.cropX}
          initialY={croppingSlot.cropY}
          initialSize={croppingSlot.cropSize}
          onClose={() => setCroppingQuadSlot(null)}
          onSave={async (crop) => {
            await detail.saveQuadSlotCrop(croppingQuadSlot, crop);
            setCroppingQuadSlot(null);
          }}
          onReset={async () => {
            await detail.resetQuadSlotCrop(croppingQuadSlot);
            setCroppingQuadSlot(null);
          }}
        />
      )}
    </div>
  );
}
