import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOpenInEditors } from "../../hooks/useOpenInEditors";
import { useRevealFiles } from "../../hooks/useRevealOriginal";
import { useInatStatus } from "../../hooks/useInatStatus";
import { useSendToInat } from "../../hooks/useSendToInat";
import SetRegionDialog from "../../components/SetRegionDialog";
import SpeciesPicker from "../../components/SpeciesPicker";
import TagEditor from "../../components/TagEditor";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import StarRating from "../../components/StarRating";
import type { GalleryEdits } from "./useGalleryEdits";
import AdjustTimeDialog from "./AdjustTimeDialog";
import ApplePhotosDialog from "../../components/ApplePhotosDialog";
import { useApplePhotosAvailable } from "../../hooks/useApplePhotosAvailable";
import CoordinatesModal from "../../components/CoordinatesModal";
import type { Appearance } from "@lifer/shared";
import { AppearanceModal } from "../../components/Appearance";
import { SelectionBar, type BarAction } from "../../components/SelectionActionRow";
import { deleteBarActions } from "../../hooks/useDeleteCaptures";
import { COMPARE_MAX, COMPARE_MIN } from "../../lib/compareZoom";

type BarDialog =
  "correctId" | "tag" | "rate" | "region" | "album" | "adjustTime" | "coordinates" | "appearance" | "applePhotos";

// Select mode's bar. In the album picker it only adds to that album; otherwise each action opens
// its own dialog: correct the ID, tag, rate, set the region, add to any album; or downloads,
// hides or deletes.
export function GallerySelectBar({
  selectedIds,
  selectingAll,
  targetAlbumId,
  edits,
  suggestedRegionIds,
  regionFirst = false,
  selectionLacksRegion = false,
  onCoordinatesSaved,
  onAppearanceSaved,
  morphOptions,
  onCompare,
  compareFirst = false,
  onPlaceOnMap,
  selectedHaveRaw = false,
  total,
  onSelectAll,
  onDeselectAll,
  revealRefs,
  onSelectBursts,
}: {
  selectedIds: ReadonlySet<string>;
  selectingAll: boolean;
  targetAlbumId: string | null;
  edits: GalleryEdits;
  /** Quick picks for Set region: the one selected photo's region, the Gallery's region filter. */
  suggestedRegionIds: Array<string | null | undefined>;
  /** Fixing photos with no region (from Stats): Set region leads, as the main action. */
  regionFirst?: boolean;
  /** Every selected photo is loaded and has no region, so coordinates may offer one. */
  selectionLacksRegion?: boolean;
  onCoordinatesSaved?: (
    captureIds: string[],
    point: { lat: number; lon: number } | null,
    region: { id: string; name: string } | null,
  ) => void;
  /** After the selection's life stage, sex, plumage or morph is set, to show it at once. */
  onAppearanceSaved?: (captureIds: string[], changes: Partial<Appearance>) => void;
  /** Morphs already used, offered while typing one. */
  morphOptions?: string[];
  /** Opens the selected photos side by side; offered for 2 to 4. */
  onCompare?: () => void;
  /** Reviewing a similar group: Compare leads, as the main action. */
  compareFirst?: boolean;
  /** Opens the map to place the selected photos by clicking a point or a saved spot. */
  onPlaceOnMap?: () => void;
  /** Some selected photos have a RAW beside an edited original, so Delete can take it too. */
  selectedHaveRaw?: boolean;
  /** How many photos match, for Select all. */
  total?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  /** The one selected photo's stored files, for Show in Finder. */
  revealRefs?: ReadonlyArray<string | null | undefined>;
  /** Adds the rest of each selected photo's burst; set while some burst is only partly selected. */
  onSelectBursts?: () => void;
}) {
  const { t } = useTranslation();
  const { bulk } = edits;
  const openInEditors = useOpenInEditors();
  const reveals = useRevealFiles(selectedIds.size === 1 ? (revealRefs ?? []) : []);
  const inat = useInatStatus();
  const sendToInat = useSendToInat();
  const applePhotos = useApplePhotosAvailable();
  const count = selectedIds.size;
  const [dialog, setDialog] = useState<BarDialog | null>(null);
  const close = () => setDialog(null);
  const tagRef = useRef<HTMLDivElement>(null);
  // TagEditor has no autofocus of its own; this runs after the Modal's own first-field focus.
  useLayoutEffect(() => {
    if (dialog === "tag") tagRef.current?.querySelector("input")?.focus();
  }, [dialog]);

  const regionAction: BarAction = {
    key: "region",
    label: t("gallery.select.setRegion"),
    onClick: () => setDialog("region"),
    variant: regionFirst ? "primary" : "secondary",
    loading: bulk.settingRegion,
  };
  const deleteActions = deleteBarActions(t, selectedHaveRaw, edits.deleteSelected);
  const actions: BarAction[] = targetAlbumId
    ? [
        {
          key: "addToTarget",
          label: edits.addingToTargetAlbum ? t("gallery.select.adding") : t("gallery.select.addToAlbum", { count }),
          onClick: edits.addSelectedToTargetAlbum,
          variant: "primary",
          loading: edits.addingToTargetAlbum,
        },
        ...deleteActions,
      ]
    : [
        ...(onCompare && count >= COMPARE_MIN && count <= COMPARE_MAX
          ? [
              {
                key: "compare",
                label: t("gallery.select.compare"),
                onClick: onCompare,
                variant: compareFirst && !regionFirst ? ("primary" as const) : undefined,
              },
            ]
          : []),
        ...(regionFirst ? [regionAction] : []),
        ...(onSelectBursts ? [{ key: "selectBursts", label: t("bursts.selectWhole"), onClick: onSelectBursts }] : []),
        {
          key: "correctId",
          label: bulk.batchReassigning ? t("gallery.select.reassigning") : t("gallery.select.correctId"),
          onClick: () => setDialog("correctId"),
          loading: bulk.batchReassigning,
        },
        { key: "tag", label: t("gallery.select.addTag"), onClick: () => setDialog("tag") },
        { key: "rate", label: t("gallery.select.rate"), onClick: () => setDialog("rate") },
        ...(regionFirst ? [] : [regionAction]),
        ...(onPlaceOnMap ? [{ key: "placeOnMap", label: t("gallery.select.placeOnMap"), onClick: onPlaceOnMap }] : []),
        { key: "album", label: t("albums.addTo.button"), onClick: () => setDialog("album") },
        { key: "download", label: t("gallery.select.downloadOriginals"), onClick: () => void bulk.download() },
        { key: "hide", label: t("gallery.select.hide"), onClick: () => void edits.hide([...selectedIds]) },
        {
          key: "coordinates",
          label: t("gallery.select.addCoordinates"),
          onClick: () => setDialog("coordinates"),
          menuOnly: true,
        },
        ...(inat?.connected
          ? [
              {
                key: "inaturalist",
                label: t("inaturalist.send.action"),
                onClick: () => void sendToInat([...selectedIds]).then((sent) => sent && edits.reload()),
                menuOnly: true,
              },
            ]
          : []),
        // The editor's own window handles a big batch badly; 200 files is the most one call opens.
        ...openInEditors.editors.map((editor) => ({
          key: `openIn-${editor.id}`,
          label: t("openIn.item", { name: editor.name }),
          onClick: () => openInEditors.openIn(editor, { captureIds: [...selectedIds].slice(0, 200) }),
          menuOnly: true,
        })),
        ...reveals.map((reveal) => ({
          key: `reveal-${reveal.label}`,
          label: reveal.label,
          onClick: reveal.run,
          menuOnly: true,
        })),
        {
          key: "appearance",
          label: t("appearance.action"),
          onClick: () => setDialog("appearance"),
          menuOnly: true,
        },
        {
          key: "adjustTime",
          label: t("gallery.adjustTime.action"),
          onClick: () => setDialog("adjustTime"),
          menuOnly: true,
        },
        ...(applePhotos
          ? [
              {
                key: "applePhotos",
                label: t("applePhotos.action"),
                onClick: () => setDialog("applePhotos"),
                menuOnly: true,
              },
            ]
          : []),
        ...deleteActions,
      ];

  return (
    <SelectionBar
      count={count}
      total={total}
      onSelectAll={onSelectAll}
      onDeselectAll={onDeselectAll}
      busyLabel={selectingAll ? t("gallery.select.selectingAll") : null}
      emptyText={t("gallery.select.none")}
      actions={actions}
    >
      {dialog === "correctId" && (
        <Modal
          open
          onClose={close}
          title={t("gallery.select.correctIdTitle", { count })}
          footer={
            <Button variant="secondary" onClick={close}>
              {t("common.cancel")}
            </Button>
          }
        >
          <SpeciesPicker
            autoFocus
            placeholder={t("gallery.select.typeSpecies")}
            onSelect={(species) => {
              close();
              void bulk.reassignSelected(species);
            }}
          />
        </Modal>
      )}
      {dialog === "tag" && (
        <Modal
          open
          onClose={close}
          title={t("gallery.select.addTagTitle", { count })}
          footer={
            <Button
              onClick={() => {
                close();
                if (bulk.tags.length > 0) edits.exitSelectMode();
              }}
            >
              {t("common.done")}
            </Button>
          }
        >
          <div ref={tagRef}>
            <TagEditor tags={bulk.tags} existingTags={edits.tagOptions} compact onChange={bulk.changeTags} />
          </div>
        </Modal>
      )}
      {dialog === "rate" && (
        <Modal
          open
          onClose={close}
          size="sm"
          title={t("gallery.select.rateTitle", { count })}
          footer={
            <Button variant="secondary" onClick={close}>
              {t("common.cancel")}
            </Button>
          }
        >
          <StarRating
            rating={null}
            size="text-title-2"
            onRate={(rating) => {
              close();
              void bulk.rate(rating);
            }}
          />
        </Modal>
      )}
      {dialog === "region" && (
        <SetRegionDialog count={count} onSet={bulk.setRegion} onClose={close} suggestedRegionIds={suggestedRegionIds} />
      )}
      {dialog === "album" && (
        <AddToAlbumModal captureIds={[...selectedIds]} onClose={close} onAdded={edits.exitSelectMode} />
      )}
      {dialog === "coordinates" && (
        <CoordinatesModal
          captureIds={[...selectedIds]}
          suggestRegion={selectionLacksRegion}
          onSaved={(point, region) => onCoordinatesSaved?.([...selectedIds], point, region)}
          onUndone={edits.reload}
          onClose={close}
        />
      )}
      {dialog === "appearance" && (
        <AppearanceModal
          captureIds={[...selectedIds]}
          morphOptions={morphOptions}
          onSaved={(changes) => onAppearanceSaved?.([...selectedIds], changes)}
          onFailed={edits.reload}
          onClose={close}
        />
      )}
      {dialog === "adjustTime" && (
        <AdjustTimeDialog
          captureIds={[...selectedIds]}
          onClose={close}
          onChanged={() => {
            edits.exitSelectMode();
            edits.reload();
          }}
        />
      )}
      {dialog === "applePhotos" && <ApplePhotosDialog captureIds={[...selectedIds]} onClose={close} />}
    </SelectionBar>
  );
}

// Select mode's bar under the "Hidden" filter: photos hidden from a menu, or rejected in a culling app.
// Unhiding is the one thing to do with them; everything else waits until they're back.
export function HiddenSelectBar({
  selectedIds,
  selectingAll,
  unhiding,
  onUnhide,
  total,
  onSelectAll,
  onDeselectAll,
}: {
  selectedIds: ReadonlySet<string>;
  selectingAll: boolean;
  unhiding: boolean;
  onUnhide: () => void;
  total?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SelectionBar
      count={selectedIds.size}
      total={total}
      onSelectAll={onSelectAll}
      onDeselectAll={onDeselectAll}
      busyLabel={selectingAll ? t("gallery.select.selectingAll") : null}
      emptyText={t("gallery.select.hiddenNote")}
      actions={[
        {
          key: "unhide",
          label: unhiding ? t("gallery.select.unhiding") : t("gallery.select.unhideSelected"),
          onClick: onUnhide,
          variant: "primary",
          loading: unhiding,
        },
      ]}
    />
  );
}
