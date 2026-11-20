import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import SpeciesPicker from "../../components/SpeciesPicker";
import TagEditor from "../../components/TagEditor";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import StarRating from "../../components/StarRating";
import type { CaptureEdits } from "./useCaptureEdits";

// Select mode's bar: correct the ID, add tags or rate every selected photo, or hide or delete them.
export function CaptureSelectBar({ selectedCount, edits }: { selectedCount: number; edits: CaptureEdits }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-control border border-line bg-surface-muted px-3 py-2 text-footnote">
      <span className="shrink-0 text-muted">{t("species.selection.selectedCount", { count: selectedCount })}</span>
      {selectedCount > 0 && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-muted">{t("species.selection.correctIdTo")}</span>
          <div className="w-56">
            <SpeciesPicker
              placeholder={t("species.selection.typeSpecies")}
              onSelect={(s) => edits.reassignSelected(s)}
            />
          </div>
          {edits.batchReassigning && <span className="shrink-0 text-muted">{t("species.selection.reassigning")}</span>}
          <span className="shrink-0 text-muted">{t("species.selection.addTag")}</span>
          <div className="w-48">
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
      )}
      <Button
        variant="secondary"
        size="sm"
        className="shrink-0"
        onClick={() => void edits.hideSelected()}
        disabled={selectedCount === 0}
      >
        {t("species.selection.hide")}
      </Button>
      <Button
        variant="danger"
        size="sm"
        className="shrink-0"
        onClick={() => edits.deleteDialog.setOpen(true)}
        disabled={selectedCount === 0}
      >
        {t("species.selection.deleteSelected")}
      </Button>
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
