import { useEffect, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, apiPath, ApiError } from "../api/client";
import { formatBytes, formatDate } from "../lib/format";
import UploadDropzone from "../components/UploadDropzone";
import RawUpload from "../components/RawUpload";
import { VolumeDestinationPicker } from "../components/VolumeDestinationPicker";
import { useVolumeDestination } from "../hooks/useVolumeDestination";
import CardCropEditor from "../components/CardCropEditor";
import DotMenu from "../components/DotMenu";
import PageHeader from "../components/PageHeader";
import { useGoBack } from "../hooks/useGoBack";
import Modal from "../components/Modal";
import { LoadingScreen } from "../components/LoadingScreen";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { downloadFile } from "../lib/downloadFile";
import { useSpeciesDetail } from "./species/useSpeciesDetail";
import SpeciesHero from "./species/SpeciesHero";
import SpeciesPhotoGrid from "./species/SpeciesPhotoGrid";
import { SpeciesOverview } from "./species/SpeciesFacts";
import ChecklistAdditions from "./species/ChecklistAdditions";
import { useSpeciesName } from "../lib/speciesName";
import { MENU_ITEM, MENU_ITEM_DANGER, MENU_PANEL, MENU_SEPARATOR } from "../lib/menuClasses";
import { storedLastRegionId } from "./collection/useCollectionData";

const GALLERY_VIEW_KEY = "lifer:galleryView";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function SpeciesDetailPage() {
  const speciesName = useSpeciesName();
  const { id } = useParams<{ id: string }>();
  const goBack = useGoBack();
  const confirm = useConfirm();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  // Without ?regionId= (a photo's species link, say), the region the Collection shows.
  const [defaultRegionId] = useState(storedLastRegionId);
  const regionId = searchParams.get("regionId") ?? defaultRegionId;
  const { detail, loadError, load, updateCaptures, encounters, unmatchedRaws, loadUnmatchedRaws, pendingUploadCount } =
    useSpeciesDetail(id, regionId);
  const [croppingCover, setCroppingCover] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
  // Any species, hand-imported or not, can be put on more regions' checklists.
  const [addingToChecklist, setAddingToChecklist] = useState(false);
  const volumeDestination = useVolumeDestination(id ?? "");
  const { openKey: openRawMenuId, setOpenKey: setOpenRawMenuId, ref: openRawMenuRef } = useDropdownMenu<string>();
  const { openKey: actionsOpen, setOpenKey: setActionsOpen, ref: actionsRef } = useDropdownMenu();

  // Hides tier, rating and camera info for showing the photos off. Remembered across species.
  const [galleryView, setGalleryView] = useState(() => {
    try {
      return localStorage.getItem(GALLERY_VIEW_KEY) === "true";
    } catch {
      return false;
    }
  });
  function toggleGalleryView() {
    setGalleryView((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(GALLERY_VIEW_KEY, String(next));
      } catch {
        // Storage unavailable: the toggle still works for this visit.
      }
      return next;
    });
  }

  // The router keeps the old scroll offset between species.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  const backFallbackTo = regionId ? `/?region=${regionId}` : "/";

  // The header renders in every state so there's always a way back.
  if (loadError) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader backFallbackTo={backFallbackTo} />
        <div className="p-8 text-muted">
          Couldn't load this species.{" "}
          <button onClick={load} className="text-ink underline">
            Retry
          </button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader backFallbackTo={backFallbackTo} />
        <LoadingScreen showBackLink={false} />
      </div>
    );
  }
  const { species, userSpecies } = detail;

  async function mutate(request: () => Promise<unknown>, failure: string) {
    try {
      await request();
      load();
    } catch (err) {
      toast.error(errorText(err, failure));
    }
  }

  const markSeen = () =>
    mutate(() => api.patch(apiPath("/species/{id}/seen", { id: id! })), "Couldn't mark this species as seen");
  const unmarkSeen = () =>
    mutate(() => api.delete(apiPath("/species/{id}/seen", { id: id! })), "Couldn't update this species");
  // Targets are independent of state: a collected species can still be targeted for a better photo.
  const addToTargets = () =>
    mutate(() => api.patch(apiPath("/species/{id}/target", { id: id! })), "Couldn't add to targets");
  const removeFromTargets = () =>
    mutate(() => api.delete(apiPath("/species/{id}/target", { id: id! })), "Couldn't remove from targets");
  const archive = () =>
    mutate(() => api.post(apiPath("/species/{id}/archive", { id: id! })), "Couldn't archive this species. Try again.");
  const unarchive = () =>
    mutate(
      () => api.delete(apiPath("/species/{id}/archive", { id: id! })),
      "Couldn't unarchive this species. Try again.",
    );

  async function removeOtherTaxa() {
    const ok = await confirm({
      title: "Remove this species?",
      message: "You can add it back later by searching iNaturalist.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(apiPath("/species/{id}/other-taxa", { id: id! }));
      // Back where it was opened from; without one, the Collection replaces the now-dead page.
      goBack("/", { replace: true });
    } catch (err) {
      toast.error(errorText(err, "Couldn't remove this species. Try again."));
    } finally {
      setRemovingOtherTaxa(false);
    }
  }

  // Errors propagate so CardCropEditor stays open and shows them.
  async function saveCrop(body: object) {
    await api.patch(apiPath("/species/{id}/card-crop", { id: id! }), body);
    load();
  }

  return (
    <div className="flex-1 bg-canvas">
      {/* Sticky: the page is long enough that the back link would scroll away. */}
      <PageHeader backFallbackTo={backFallbackTo} />

      {/* Wide screens: the hero beside the species' cards, then the photos across the full width.
          Narrow: stacked. */}
      <main className="mx-auto w-full max-w-[120rem] space-y-section p-page">
        {/* The species, its photo, then what to know about it beside where and when it's seen, then
            your photos. */}
        <header className="flex items-start justify-between gap-item">
          <div className="min-w-0">
            <h1 className="text-3xl font-semibold text-ink">{speciesName(species)}</h1>
            <p className="mt-1 text-sm text-muted">
              <span className="italic">{species.scientific_name}</span>
              {encounters?.firstPhotographedAt && <> · First observed {formatDate(encounters.firstPhotographedAt)}</>}
            </p>
          </div>
          {/* Rare actions, kept out of the way in a menu. */}
          <DotMenu
            open={actionsOpen === true}
            onToggle={() => setActionsOpen(actionsOpen ? null : true)}
            menuRef={actionsRef}
            className="relative shrink-0"
            plain
          >
            <div
              onClick={() => setActionsOpen(null)}
              className={`absolute right-0 top-full z-10 mt-1 whitespace-nowrap ${MENU_PANEL}`}
            >
              {userSpecies?.cover_photo_id && (
                <MenuItem onClick={() => setCroppingCover(true)}>Adjust card preview</MenuItem>
              )}
              {userSpecies?.state !== "collected" &&
                (userSpecies?.state === "seen" ? (
                  <MenuItem onClick={unmarkSeen}>Mark as unseen</MenuItem>
                ) : (
                  <MenuItem onClick={markSeen}>Mark as seen</MenuItem>
                ))}
              {userSpecies?.is_target ? (
                <MenuItem onClick={removeFromTargets}>Remove from targets</MenuItem>
              ) : (
                <MenuItem onClick={addToTargets}>Add to targets</MenuItem>
              )}
              {/* Archived species leave checklists but stay reachable here so they can be unarchived. */}
              {detail.isArchived ? (
                <MenuItem onClick={unarchive}>Unarchive</MenuItem>
              ) : userSpecies?.state !== "collected" ? (
                <MenuItem onClick={archive}>Archive</MenuItem>
              ) : null}
              <MenuItem onClick={() => setAddingToChecklist(true)}>Add to another checklist</MenuItem>
              {/* The server refuses removal once a photo exists, so it's only offered before then. */}
              {species.is_other_taxa && userSpecies?.state !== "collected" && (
                <>
                  <div className={MENU_SEPARATOR} />
                  <MenuItem onClick={removeOtherTaxa} disabled={removingOtherTaxa} danger>
                    {removingOtherTaxa ? "Removing…" : "Remove species"}
                  </MenuItem>
                </>
              )}
            </div>
          </DotMenu>
        </header>
        <ChecklistAdditions
          speciesId={species.id}
          speciesName={speciesName(species)}
          adding={addingToChecklist}
          onDoneAdding={() => setAddingToChecklist(false)}
        />

        <SpeciesHero detail={detail} />

        <SpeciesOverview detail={detail} encounters={encounters} />

        <SpeciesPhotoGrid
          detail={detail}
          pendingUploadCount={pendingUploadCount}
          load={load}
          updateCaptures={updateCaptures}
          galleryView={galleryView}
          onToggleGalleryView={toggleGalleryView}
          onUpload={() => setShowUploadDialog(true)}
        />
        {/* RAWs filed with no matching JPEG: no capture to rate or preview, so Download is the one action. */}
        {unmatchedRaws.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium text-ink">RAW gallery</h2>
            <div className="flex flex-wrap gap-3">
              {unmatchedRaws.map((r) => (
                <div key={r.id} className="group relative w-32">
                  <img
                    src={r.previewUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full rounded-md bg-surface-muted object-cover"
                  />
                  <DotMenu
                    open={openRawMenuId === r.id}
                    onToggle={() => setOpenRawMenuId(openRawMenuId === r.id ? null : r.id)}
                    menuRef={openRawMenuRef}
                  >
                    <div className={`absolute right-0 top-full z-10 mt-1 whitespace-nowrap ${MENU_PANEL}`}>
                      <button
                        onClick={() => {
                          setOpenRawMenuId(null);
                          downloadFile(r.downloadUrl, r.filename ?? "original.raw");
                        }}
                        className={MENU_ITEM}
                      >
                        Download
                      </button>
                    </div>
                  </DotMenu>
                  <p className="mt-1 truncate text-xs text-ink">{r.filename}</p>
                  <p className="text-xs text-muted">{formatBytes(r.fileSize)}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <Modal open={showUploadDialog} onClose={() => setShowUploadDialog(false)} title="Upload" size="lg">
        <div className="space-y-4">
          <VolumeDestinationPicker {...volumeDestination} />
          <UploadDropzone
            speciesId={species.id}
            volumeId={volumeDestination.volumeId}
            onUploaded={load}
            onClose={() => setShowUploadDialog(false)}
          />
          <div className="border-t border-line pt-4">
            <RawUpload speciesId={species.id} volumeId={volumeDestination.volumeId} onFiled={loadUnmatchedRaws} />
          </div>
        </div>
      </Modal>

      {croppingCover && userSpecies?.cover_photo_id && (
        <CardCropEditor
          photoUrl={`/api/photos/${userSpecies.cover_photo_id}/display`}
          initialX={userSpecies.card_crop_x == null ? null : Number(userSpecies.card_crop_x)}
          initialY={userSpecies.card_crop_y == null ? null : Number(userSpecies.card_crop_y)}
          initialSize={userSpecies.card_crop_size == null ? null : Number(userSpecies.card_crop_size)}
          onClose={() => setCroppingCover(false)}
          onSave={(crop) => saveCrop(crop)}
          onReset={() => saveCrop({ reset: true })}
        />
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled} className={danger ? MENU_ITEM_DANGER : MENU_ITEM}>
      {children}
    </button>
  );
}
