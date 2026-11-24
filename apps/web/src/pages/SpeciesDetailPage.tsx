import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useReadyMarker } from "../lib/readyMarker";
import ProgressiveImg from "../components/ProgressiveImg";
import { useLocation, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { formatBytes, formatDate } from "../lib/format";
import UploadDropzone from "../components/UploadDropzone";
import RawUpload from "../components/RawUpload";
import { VolumeDestinationPicker } from "../components/VolumeDestinationPicker";
import { useVolumeDestination } from "../hooks/useVolumeDestination";
import CardCropEditor from "../components/CardCropEditor";
import Menu, { MenuItem, MenuPanel, MenuSection } from "../components/Menu";
import Button from "../components/Button";
import { useLightbox } from "../components/Lightbox";
import EmptyState from "../components/EmptyState";
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
import { namePartClass, useSpeciesName, useSpeciesNameParts } from "../lib/speciesName";
import SpeciesNameText from "../components/SpeciesNameText";
import { storedLastRegionId } from "./collection/useCollectionData";

export default function SpeciesDetailPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const speciesNameParts = useSpeciesNameParts();
  const { id } = useParams<{ id: string }>();
  const goBack = useGoBack();
  const confirm = useConfirm();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  // Without ?regionId= (a photo's species link, say), the region the Collection shows.
  const [defaultRegionId] = useState(storedLastRegionId);
  const regionId = searchParams.get("regionId") ?? defaultRegionId;
  // Opened from a trip's species: its photos get their own section. The name rides on the back
  // label, which history keeps across a reload.
  const tripId = searchParams.get("trip");
  const tripName = (useLocation().state as { backLabel?: string } | null)?.backLabel ?? null;
  const trip = useMemo(() => (tripId ? { id: tripId, name: tripName } : undefined), [tripId, tripName]);
  const { detail, loadError, load, updateCaptures, encounters, unmatchedRaws, loadUnmatchedRaws, pendingUploadCount } =
    useSpeciesDetail(id, regionId);
  useReadyMarker(!!detail);
  const [croppingCover, setCroppingCover] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [removingOtherTaxa, setRemovingOtherTaxa] = useState(false);
  // Any species, hand-imported or not, can be put on more regions' checklists.
  const [addingToChecklist, setAddingToChecklist] = useState(false);
  const volumeDestination = useVolumeDestination(id ?? "");
  const rawViewer = useLightbox();
  const rawSlides = useMemo(
    () =>
      unmatchedRaws.map((r) => ({
        url: r.previewUrl,
        thumbUrl: r.previewUrl,
        caption: r.filename,
        download: { url: r.downloadUrl, filename: r.filename ?? "original.raw" },
      })),
    [unmatchedRaws],
  );
  const { openKey: openRawMenuId, setOpenKey: setOpenRawMenuId, ref: openRawMenuRef } = useDropdownMenu<string>();
  const { openKey: actionsOpen, setOpenKey: setActionsOpen, ref: actionsRef } = useDropdownMenu();

  // The router keeps the old scroll offset between species.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  const backFallbackTo = tripId ? `/trips/${tripId}` : regionId ? `/?region=${regionId}` : "/";

  // The header renders in every state so there's always a way back.
  if (loadError) {
    return (
      <div className="flex-1 bg-canvas">
        <PageHeader backFallbackTo={backFallbackTo} />
        <EmptyState title={t("species.detail.loadFailed")} action={{ label: t("common.retry"), onClick: load }} />
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
  const nameParts = speciesNameParts(species);

  /** True once it worked; a failure is shown and returns false. */
  async function mutate(request: () => Promise<unknown>, failure: string): Promise<boolean> {
    try {
      await request();
      load();
      return true;
    } catch (err) {
      toast.error(errorMessage(err, failure));
      return false;
    }
  }

  const markSeen = () =>
    mutate(() => api.patch(apiPath("/species/{id}/seen", { id: id! })), t("species.detail.markSeenFailed"));
  const unmarkSeen = () =>
    mutate(() => api.delete(apiPath("/species/{id}/seen", { id: id! })), t("species.detail.updateFailed"));
  // Targets are independent of state: a collected species can still be targeted for a better photo.
  const addToTargets = () =>
    mutate(() => api.patch(apiPath("/species/{id}/target", { id: id! })), t("species.detail.addTargetFailed"));
  const removeFromTargets = () =>
    mutate(() => api.delete(apiPath("/species/{id}/target", { id: id! })), t("species.detail.removeTargetFailed"));

  // The header toggles say what changed, with a way back, as the cards' menu does.
  async function toggleWithUndo(doIt: () => Promise<boolean>, undo: () => Promise<boolean>, message: string) {
    if (!(await doIt())) return;
    toast.show(message, { tone: "success", actions: [{ label: t("species.edits.undo"), onClick: () => void undo() }] });
  }
  const seen = userSpecies?.state === "seen";
  const toggleSeen = () =>
    seen
      ? toggleWithUndo(unmarkSeen, markSeen, t("species.detail.markedNotSeen"))
      : toggleWithUndo(markSeen, unmarkSeen, t("species.detail.markedSeen"));
  const target = !!userSpecies?.is_target;
  const toggleTarget = () =>
    target
      ? toggleWithUndo(removeFromTargets, addToTargets, t("species.detail.removedFromTargets"))
      : toggleWithUndo(addToTargets, removeFromTargets, t("species.detail.addedToTargets"));
  // Set by the user's connected apps (userdata.write); Lifer shows it and lets the user clear it.
  const needsBetter = !!userSpecies?.needs_better_photo;
  const needsBetterPath = apiPath("/userdata/v1/species/{id}/needs-better-photo", { id: id! });
  const clearNeedsBetter = () =>
    toggleWithUndo(
      () => mutate(() => api.delete(needsBetterPath), t("species.detail.updateFailed")),
      () => mutate(() => api.put(needsBetterPath), t("species.detail.updateFailed")),
      t("species.detail.needsBetterCleared"),
    );
  const archive = () =>
    mutate(() => api.post(apiPath("/species/{id}/archive", { id: id! })), t("species.detail.archiveFailed"));
  const unarchive = () =>
    mutate(() => api.delete(apiPath("/species/{id}/archive", { id: id! })), t("species.detail.unarchiveFailed"));

  async function removeOtherTaxa() {
    const ok = await confirm({
      title: t("species.detail.removeConfirm.title"),
      message: t("species.detail.removeConfirm.message"),
      confirmLabel: t("species.detail.removeConfirm.confirm"),
      danger: true,
    });
    if (!ok) return;
    setRemovingOtherTaxa(true);
    try {
      await api.delete(apiPath("/species/{id}/other-taxa", { id: id! }));
      // Back where it was opened from; without one, the Collection replaces the now-dead page.
      goBack("/", { replace: true });
    } catch (err) {
      toast.error(errorMessage(err, t("species.detail.removeFailed")));
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
      {/* The species' actions sit in the bar with the back link, at its trailing edge, as a Mac
          app's toolbar holds a page's actions: the common ones as toggles, the rare ones in More. */}
      <PageHeader
        backFallbackTo={backFallbackTo}
        actions={
          <div className="flex items-center gap-2">
            {userSpecies?.state !== "collected" && (
              <HeaderToggle on={seen} onClick={toggleSeen} title={t("species.detail.seenTitle")}>
                {t("species.detail.seen")}
              </HeaderToggle>
            )}
            {needsBetter && (
              <HeaderToggle on onClick={() => void clearNeedsBetter()} title={t("species.detail.needsBetterTitle")}>
                {t("species.detail.needsBetter")}
              </HeaderToggle>
            )}
            <HeaderToggle on={target} onClick={toggleTarget} title={t("species.detail.targetTitle")}>
              {t("species.detail.target")}
            </HeaderToggle>
            {/* Rare actions, kept out of the way in a menu. */}
            <Menu
              open={actionsOpen === true}
              onToggle={() => setActionsOpen(actionsOpen ? null : true)}
              menuRef={actionsRef}
              className="relative shrink-0"
              trigger="plain"
            >
              <MenuPanel className="whitespace-nowrap">
                <MenuSection>
                  {userSpecies?.cover_photo_id && (
                    <MenuItem onSelect={() => setCroppingCover(true)}>{t("species.detail.adjustCardPreview")}</MenuItem>
                  )}
                </MenuSection>
                <MenuSection>
                  <MenuItem onSelect={() => setAddingToChecklist(true)}>{t("species.detail.addToChecklist")}</MenuItem>
                </MenuSection>
                <MenuSection>
                  {/* Archived species leave the lists but stay reachable here so they can be unarchived. */}
                  {detail.isArchived ? (
                    <MenuItem onSelect={() => void unarchive()}>{t("species.detail.countAgain")}</MenuItem>
                  ) : userSpecies?.state !== "collected" ? (
                    <MenuItem onSelect={() => void archive()}>{t("species.detail.dontCount")}</MenuItem>
                  ) : null}
                </MenuSection>
                <MenuSection>
                  {/* The server refuses removal once a photo exists, so it's only offered before then. */}
                  {species.is_other_taxa && userSpecies?.state !== "collected" && (
                    <MenuItem onSelect={() => void removeOtherTaxa()} disabled={removingOtherTaxa} danger>
                      {removingOtherTaxa ? t("species.detail.removing") : t("species.detail.removeSpecies")}
                    </MenuItem>
                  )}
                </MenuSection>
              </MenuPanel>
            </Menu>
          </div>
        }
      />

      {/* Wide screens: the hero beside the species' cards, then the photos across the full width.
          Narrow: stacked. */}
      <main className="mx-auto w-full max-w-[120rem] space-y-section p-page">
        {/* The species, its photo, then what to know about it beside where and when it's seen, then
            your photos. */}
        <header>
          <div className="min-w-0">
            <h1 className={`text-large-title font-semibold text-ink ${namePartClass(nameParts.primary)}`}>
              {nameParts.primary.text}
            </h1>
            <p className="mt-1 text-callout text-muted">
              <SpeciesNameText parts={nameParts.secondary} />
              {nameParts.secondary.length > 0 && encounters?.firstPhotographedAt && " · "}
              {encounters?.firstPhotographedAt &&
                t("species.detail.firstObserved", { date: formatDate(encounters.firstPhotographedAt) })}
            </p>
          </div>
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
          onUpload={() => setShowUploadDialog(true)}
          trip={trip}
        />
        {/* RAWs filed with no matching JPEG: no capture to rate, so viewing and Download are the actions.
            A long run scrolls inside its own box. */}
        {unmatchedRaws.length > 0 && (
          <section>
            <h2 className="mb-2 text-callout font-medium text-ink">{t("species.detail.rawGallery")}</h2>
            <div className="flex max-h-[32rem] flex-wrap gap-3 overflow-y-auto">
              {unmatchedRaws.map((r, i) => (
                <div key={r.id} className="group relative w-32">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={r.filename ?? t("species.detail.rawGallery")}
                    onClick={() => rawViewer.open(rawSlides, i)}
                    className="aspect-square h-auto! w-full overflow-hidden p-0!"
                  >
                    <ProgressiveImg
                      thumbSrc={r.previewUrl}
                      fullSrc={r.previewUrl}
                      alt=""
                      className="aspect-square w-full rounded-control object-cover"
                    />
                  </Button>
                  <Menu
                    open={openRawMenuId === r.id}
                    onToggle={() => setOpenRawMenuId(openRawMenuId === r.id ? null : r.id)}
                    menuRef={openRawMenuRef}
                  >
                    <MenuPanel className="whitespace-nowrap">
                      <MenuItem onSelect={() => downloadFile(r.downloadUrl, r.filename ?? "original.raw")}>
                        {t("species.detail.download")}
                      </MenuItem>
                    </MenuPanel>
                  </Menu>
                  <p className="mt-1 truncate text-footnote text-ink" title={r.filename ?? undefined}>
                    {r.filename}
                  </p>
                  <p className="text-footnote text-muted">{formatBytes(r.fileSize)}</p>
                </div>
              ))}
            </div>
          </section>
        )}
        {rawViewer.node}
      </main>

      <Modal
        open={showUploadDialog}
        onClose={() => setShowUploadDialog(false)}
        title={t("species.detail.upload")}
        footer={
          <Button variant="secondary" onClick={() => setShowUploadDialog(false)}>
            {t("common.done")}
          </Button>
        }
      >
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

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A state you turn on and off (Seen, Target): a checkmark and the accent while on.
function HeaderToggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={on}
      onClick={onClick}
      tooltip={{ label: title }}
      className={`gap-1.5 ${on ? "border-accent bg-accent/10 text-ink" : ""}`}
    >
      {on && <CheckIcon />}
      {children}
    </Button>
  );
}
