import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import SpeciesPicker from "../../components/SpeciesPicker";
import TagEditor from "../../components/TagEditor";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import StarRating from "../../components/StarRating";
import { SelectionBar, type BarAction } from "../../components/SelectionActionRow";
import type { CaptureEdits } from "./useCaptureEdits";

// Select mode's bar, the shared one: correct the ID, add tags or rate every selected photo, or
// hide or delete them.
export function CaptureSelectBar({
  selectedCount,
  edits,
  total,
  onSelectAll,
  onDeselectAll,
}: {
  selectedCount: number;
  edits: CaptureEdits;
  /** How many photos are listed, for Select all. */
  total?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
}) {
  const { t } = useTranslation();
  const actions: BarAction[] = [
    { key: "hide", label: t("species.selection.hide"), onClick: () => void edits.hideSelected() },
    {
      key: "delete",
      label: t("species.selection.deleteSelected"),
      variant: "danger",
      onClick: () => edits.deleteDialog.setOpen(true),
    },
  ];
  return (
    <div className="mb-2">
      <SelectionBar
        count={selectedCount}
        total={total}
        onSelectAll={onSelectAll}
        onDeselectAll={onDeselectAll}
        busyLabel={edits.batchReassigning ? t("species.selection.reassigning") : null}
        emptyText={t("gallery.select.none")}
        actions={actions}
        links={
          selectedCount > 0 && (
            // Wraps in a narrow window rather than pushing the bar past its edge.
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="shrink-0 text-muted">{t("species.selection.correctIdTo")}</span>
              <div className="w-56 max-w-full">
                <SpeciesPicker
                  placeholder={t("species.selection.typeSpecies")}
                  onSelect={(s) => edits.reassignSelected(s)}
                />
              </div>
              <span className="shrink-0 text-muted">{t("species.selection.addTag")}</span>
              <div className="w-48 max-w-full">
                <TagEditor
                  tags={edits.bulkTags}
                  existingTags={edits.tagOptions}
                  compact
                  onChange={(tags) => void edits.addBulkTags(tags)}
                />
              </div>
              {edits.bulkTags.length > 0 && (
                <Button size="sm" className="shrink-0" onClick={edits.exitSelectMode}>
                  {t("common.done")}
                </Button>
              )}
              <span className="shrink-0 text-muted">{t("species.selection.rate")}</span>
              <StarRating rating={null} onRate={(rating) => void edits.rateSelected(rating)} />
            </div>
          )
        }
      />
    </div>
  );
}

// Used for one photo too (its menu's Delete selects just it), so the trash wording lives here only.
export function DeleteCapturesDialog({
  dialog,
  count,
  noun,
  selectedHaveRaw,
  deleteButtonRef,
}: {
  dialog: CaptureEdits["deleteDialog"];
  count: number;
  noun: "file" | "video" | "photo" | "RAW" | "recording";
  selectedHaveRaw: boolean;
  deleteButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={dialog.open}
      onClose={dialog.cancel}
      title={t("species.selection.deleteTitle", { count, noun })}
      size="sm"
      onKeyDown={dialog.onKeyDown}
      initialFocusRef={deleteButtonRef}
      footer={
        <>
          <Button variant="secondary" onClick={dialog.cancel} disabled={dialog.deleting}>
            {t("common.cancel")}
          </Button>
          <Button
            ref={deleteButtonRef}
            variant="danger"
            onClick={() => void dialog.confirm()}
            loading={dialog.deleting}
          >
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <p className="text-callout text-muted">{t("species.selection.trashMessage", { noun })}</p>
      {selectedHaveRaw && (
        <Checkbox checked={dialog.deleteRawToo} onChange={dialog.setDeleteRawToo} className="mt-3">
          {t("species.selection.deleteRawToo")}
        </Checkbox>
      )}
    </Modal>
  );
}
