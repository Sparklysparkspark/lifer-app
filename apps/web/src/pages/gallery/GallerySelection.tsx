import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useOpenInEditors } from "../../hooks/useOpenInEditors";
import { useInatStatus } from "../../hooks/useInatStatus";
import { useSendToInat } from "../../hooks/useSendToInat";
import RegionBrowser from "../../components/RegionBrowser";
import PlaceNameInput from "../../components/PlaceNameInput";
import SpeciesPicker from "../../components/SpeciesPicker";
import TagEditor from "../../components/TagEditor";
import AddToAlbumModal from "../../components/AddToAlbumModal";
import InlineSpinner from "../../components/InlineSpinner";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import StarRating from "../../components/StarRating";
import type { GalleryEdits } from "./useGalleryEdits";
import { formatNumber } from "../../lib/format";
import Checkbox from "../../components/Checkbox";
import AdjustTimeDialog from "./AdjustTimeDialog";
import CoordinatesModal from "../../components/CoordinatesModal";
import type { Appearance } from "@lifer/shared";
import { AppearanceModal } from "../../components/Appearance";
import { SelectionBar, type BarAction } from "../../components/SelectionActionRow";
import { COMPARE_MAX, COMPARE_MIN } from "../../lib/compareZoom";

function TrashNote({ noun }: { noun: string }) {
  const { t } = useTranslation();
  return <p className="text-callout text-muted">{t("gallery.select.trashNote", { noun })}</p>;
}

// Same region picker as a photo's location editor, for the whole selection.
function SetRegionDialog({
  count,
  onSet,
  onClose,
  suggestedRegionIds,
}: {
  count: number;
  onSet: (regionId: string, locationLabel: string) => Promise<void>;
  onClose: () => void;
  suggestedRegionIds: Array<string | null | undefined>;
}) {
  const { t } = useTranslation();
  const [regionId, setRegionId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={t("gallery.select.setRegionTitle", { count })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!regionId}
            onClick={() => {
              if (regionId) void onSet(regionId, label);
              onClose();
            }}
          >
            {t("gallery.select.setRegionApply")}
          </Button>
        </>
      }
    >
      <RegionBrowser
        regionId={regionId}
        onChange={setRegionId}
        allowAnyRegion
        suggestedRegionIds={suggestedRegionIds}
      />
      <div className="mt-4 text-callout">
        <label htmlFor="bulk-place-name" className="mb-1 block text-muted">
          {t("captureEdit.location.placeName")}
          <span className="ml-1.5 text-footnote">{t("import.rows.optional")}</span>
        </label>
        <PlaceNameInput id="bulk-place-name" value={label} onChange={setLabel} regionId={regionId} />
        <p className="mt-1 text-footnote text-muted">{t("gallery.select.setRegionPlaceHint")}</p>
      </div>
    </Modal>
  );
}

type BarDialog = "correctId" | "tag" | "rate" | "region" | "album" | "adjustTime" | "coordinates" | "appearance";

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
}) {
  const { t } = useTranslation();
  const { bulk } = edits;
  const openInEditors = useOpenInEditors();
  const inat = useInatStatus();
  const sendToInat = useSendToInat();
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
  const deleteAction: BarAction = {
    key: "delete",
    label: t("gallery.select.deleteSelected"),
    onClick: () => edits.batch.setOpen(true),
    variant: "danger",
  };
  const actions: BarAction[] = targetAlbumId
    ? [
        {
          key: "addToTarget",
          label: edits.addingToTargetAlbum ? t("gallery.select.adding") : t("gallery.select.addToAlbum", { count }),
          onClick: edits.addSelectedToTargetAlbum,
          variant: "primary",
          loading: edits.addingToTargetAlbum,
        },
        deleteAction,
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
          onClick: () => openInEditors.openIn(editor, [...selectedIds].slice(0, 200)),
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
        deleteAction,
      ];

  return (
    <SelectionBar
      count={count}
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
    </SelectionBar>
  );
}

// "Delete this photo?" from a tile's menu, and "Delete N photos?" for the selection.
export function GalleryDeleteDialogs({
  edits,
  singleNoun,
  selectedCount,
  batchNoun,
  selectedHaveRaw,
  deleteButtonRef,
  batchDeleteButtonRef,
}: {
  edits: GalleryEdits;
  /** "photo", "video" or "RAW" for the one being deleted. */
  singleNoun: string;
  selectedCount: number;
  batchNoun: string;
  selectedHaveRaw: boolean;
  deleteButtonRef: RefObject<HTMLButtonElement | null>;
  batchDeleteButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const { single, batch, deleting } = edits;
  return (
    <>
      <Modal
        open={!!single.captureId}
        onClose={() => single.request(null)}
        title={t("gallery.select.deleteOne", { noun: singleNoun })}
        size="sm"
        initialFocusRef={deleteButtonRef}
        footer={
          <>
            <Button variant="secondary" onClick={() => single.request(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              ref={deleteButtonRef}
              variant="danger"
              loading={deleting}
              onClick={() => single.captureId && single.confirm(single.captureId)}
            >
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <TrashNote noun={singleNoun} />
      </Modal>

      <Modal
        open={batch.open}
        onClose={batch.close}
        title={t("gallery.select.deleteMany", { noun: batchNoun, count: selectedCount })}
        size="sm"
        initialFocusRef={batchDeleteButtonRef}
        footer={
          <>
            <Button variant="secondary" onClick={batch.close}>
              {t("common.cancel")}
            </Button>
            <Button ref={batchDeleteButtonRef} variant="danger" loading={deleting} onClick={batch.confirm}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </Button>
          </>
        }
      >
        <TrashNote noun={batchNoun} />
        {selectedHaveRaw && (
          <Checkbox checked={batch.deleteRawToo} onChange={batch.setDeleteRawToo} className="mt-3">
            {t("gallery.select.deleteRawToo")}
          </Checkbox>
        )}
      </Modal>
    </>
  );
}

// Select mode's bar under the "Hidden" filter: photos hidden from a menu, or rejected in a culling app.
// Unhiding is the one thing to do with them; everything else waits until they're back.
export function HiddenSelectBar({
  selectedIds,
  selectingAll,
  unhiding,
  onUnhide,
}: {
  selectedIds: ReadonlySet<string>;
  selectingAll: boolean;
  unhiding: boolean;
  onUnhide: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-page py-2 text-footnote">
      <span className="shrink-0 text-muted">
        {t("gallery.select.selected", { count: formatNumber(selectedIds.size) })}
      </span>
      {selectingAll && <InlineSpinner size="xs" label={t("gallery.select.selectingAll")} />}
      <span className="min-w-0 flex-1 text-muted">{t("gallery.select.hiddenNote")}</span>
      <Button size="sm" onClick={onUnhide} disabled={selectedIds.size === 0} loading={unhiding} className="shrink-0">
        {unhiding ? t("gallery.select.unhiding") : t("gallery.select.unhideSelected")}
      </Button>
    </div>
  );
}
