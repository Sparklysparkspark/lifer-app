import { useEffect, useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { formatBytes } from "../lib/formatBytes";
import UploadDropzone from "../components/UploadDropzone";
import RawUpload from "../components/RawUpload";
import { useVolumeDestination, VolumeDestinationPicker } from "../components/VolumeDestinationPicker";
import CardCropEditor from "../components/CardCropEditor";
import RegionBrowser from "../components/RegionBrowser";
import DotMenu from "../components/DotMenu";
import PageHeader from "../components/PageHeader";
import Modal from "../components/Modal";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { LoadingScreen } from "../components/LoadingScreen";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { downloadFile } from "../lib/downloadFile";
import { useSpeciesDetail } from "./species/useSpeciesDetail";
import SpeciesHero from "./species/SpeciesHero";
import SpeciesPhotoGrid from "./species/SpeciesPhotoGrid";
import { EncounterSummary, SpeciesAbout, SpeciesBadges } from "./species/SpeciesFacts";

const GALLERY_VIEW_KEY = "lifer:galleryView";
const HEADER_ACTION = "text-xs text-muted hover:underline";

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export default function SpeciesDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const regionId = searchParams.get("regionId");
  const { detail, loadError, load, updateCaptures, encounters, unmatchedRaws, loadUnmatchedRaws, pendingUploadCount } =
    useSpeciesDetail(id, regionId);
  const [croppingCover, setCroppingCover] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
  // An Other Taxa species can sit on several regions' checklists.
  const [addingToRegion, setAddingToRegion] = useState(false);
  const [addRegionId, setAddRegionId] = useState<string | null>(null);
  const [addRegionStatus, setAddRegionStatus] = useState<"idle" | "saving" | "done" | "error">("idle");
  const volumeDestination = useVolumeDestination(id ?? "");
  const { openKey: openRawMenuId, setOpenKey: setOpenRawMenuId, ref: openRawMenuRef } = useDropdownMenu<string>();

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

  const markSeen = () => mutate(() => api.patch(`/species/${id}/seen`), "Couldn't mark this species as seen");
  const unmarkSeen = () => mutate(() => api.delete(`/species/${id}/seen`), "Couldn't update this species");
  // Targets are independent of state: a collected species can still be targeted for a better photo.
  const addToTargets = () => mutate(() => api.patch(`/species/${id}/target`), "Couldn't add to targets");
  const removeFromTargets = () => mutate(() => api.delete(`/species/${id}/target`), "Couldn't remove from targets");
  const archive = () => mutate(() => api.post(`/species/${id}/archive`), "Couldn't archive this species. Try again.");
  const unarchive = () => mutate(() => api.delete(`/species/${id}/archive`), "Couldn't unarchive this species. Try again.");

  async function removeOtherTaxa() {
    const ok = await confirm({
      title: "Remove this species?",
      message: "This can't be undone. You'd need to search and add it again from iNaturalist.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(`/species/${id}/other-taxa`);
      navigate("/");
    } catch (err) {
      toast.error(errorText(err, "Couldn't remove this species. Try again."));
    } finally {
      setRemovingOtherTaxa(false);
    }
  }

  async function addToAnotherRegion() {
    if (!addRegionId || !species.inat_taxon_id) return;
    setAddRegionStatus("saving");
    try {
      await api.post("/species/other-taxa", { inatTaxonId: species.inat_taxon_id, regionId: addRegionId });
      setAddRegionStatus("done");
      setAddRegionId(null);
      setTimeout(() => setAddingToRegion(false), 1200);
    } catch {
      setAddRegionStatus("error");
    }
  }

  // Errors propagate so CardCropEditor stays open and shows them.
  async function saveCrop(body: object) {
    await api.patch(`/species/${id}/card-crop`, body);
    load();
  }

  return (
    <div className="flex-1 bg-canvas">
      {/* Sticky: the page is long enough that the back link would scroll away. */}
      <PageHeader backFallbackTo={backFallbackTo} sticky />

      {/* <main> is full width for the photo grid; the species info sits in a narrower column. */}
      <main className="w-full space-y-6 p-6">
        <div className="mx-auto max-w-[62.4rem] space-y-6">
          <SpeciesHero detail={detail} />

          <div>
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-2xl font-semibold text-ink">{species.common_name ?? species.scientific_name}</h1>
                <p className="italic text-muted">{species.scientific_name}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {userSpecies?.cover_photo_id && (
                  <button onClick={() => setCroppingCover(true)} className={HEADER_ACTION}>
                    Adjust card preview
                  </button>
                )}
                {userSpecies?.state !== "collected" &&
                  (userSpecies?.state === "seen" ? (
                    <button onClick={unmarkSeen} className={HEADER_ACTION}>
                      Mark as unseen
                    </button>
                  ) : (
                    <button onClick={markSeen} className={HEADER_ACTION}>
                      Mark as seen
                    </button>
                  ))}
                {userSpecies?.is_target ? (
                  <button onClick={removeFromTargets} className={HEADER_ACTION}>
                    ★ Target (remove)
                  </button>
                ) : (
                  <button onClick={addToTargets} className={HEADER_ACTION}>
                    Add to targets
                  </button>
                )}
                {/* Archived species leave checklists but stay reachable here so they can be unarchived. */}
                {detail.isArchived ? (
                  <button onClick={unarchive} className={HEADER_ACTION}>
                    Archived (unarchive)
                  </button>
                ) : userSpecies?.state !== "collected" ? (
                  <button onClick={archive} className={HEADER_ACTION}>
                    Archive
                  </button>
                ) : null}
                {species.is_other_taxa && species.inat_taxon_id && (
                  <button onClick={() => setAddingToRegion((v) => !v)} className={HEADER_ACTION}>
                    Add to another region
                  </button>
                )}
                {/* The server refuses removal once a photo exists, so it's only offered before then. */}
                {species.is_other_taxa && userSpecies?.state !== "collected" && (
                  <button
                    onClick={removeOtherTaxa}
                    disabled={removingOtherTaxa}
                    className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    {removingOtherTaxa ? "Removing…" : "Remove species"}
                  </button>
                )}
              </div>
            </div>
            {addingToRegion && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="min-w-0 flex-1">
                  <RegionBrowser regionId={addRegionId} onChange={setAddRegionId} allowAnyRegion />
                </div>
                <Button size="sm" className="shrink-0" onClick={addToAnotherRegion} disabled={!addRegionId} loading={addRegionStatus === "saving"}>
                  Add
                </Button>
                {addRegionStatus === "done" && <span className="shrink-0 text-xs text-muted">Added.</span>}
                {addRegionStatus === "error" && <FormMessage error="Couldn't add. Try again." className="shrink-0" />}
              </div>
            )}
            {!galleryView && <SpeciesBadges detail={detail} />}
          </div>

          <EncounterSummary encounters={encounters} />
          <SpeciesAbout detail={detail} />
        </div>

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
                <div key={r.id} className="group relative w-32 rounded-md border border-line bg-surface p-2 text-center">
                  <img src={r.previewUrl} alt="" loading="lazy" className="aspect-square w-full rounded-sm bg-surface-muted object-cover" />
                  <DotMenu
                    open={openRawMenuId === r.id}
                    onToggle={() => setOpenRawMenuId(openRawMenuId === r.id ? null : r.id)}
                    menuRef={openRawMenuRef}
                  >
                    <div className="absolute right-0 top-full z-10 mt-1 whitespace-nowrap rounded-md border border-line bg-surface py-1 text-xs shadow-lg">
                      <button
                        onClick={() => {
                          setOpenRawMenuId(null);
                          downloadFile(r.downloadUrl, r.filename ?? "original.raw");
                        }}
                        className="block w-full px-3 py-1.5 text-left text-ink hover:bg-surface-muted"
                      >
                        Download
                      </button>
                    </div>
                  </DotMenu>
                  <p className="mt-1 truncate text-[10px] text-muted">{r.filename}</p>
                  <p className="text-[9px] text-muted">{formatBytes(r.fileSize)}</p>
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
          <RawUpload speciesId={species.id} volumeId={volumeDestination.volumeId} onFiled={loadUnmatchedRaws} />
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
