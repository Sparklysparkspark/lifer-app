import { useTranslation } from "react-i18next";
import SpeciesPicker from "../../components/SpeciesPicker";
import TagEditor from "../../components/TagEditor";
import Button from "../../components/Button";
import StarRating from "../../components/StarRating";
import { SelectionBar, type BarAction } from "../../components/SelectionActionRow";
import { deleteBarActions } from "../../hooks/useDeleteCaptures";
import type { CaptureEdits } from "./useCaptureEdits";

// Select mode's bar, the shared one: correct the ID, add tags or rate every selected photo, or
// hide or delete them.
export function CaptureSelectBar({
  selectedCount,
  selectedHaveRaw = false,
  edits,
  total,
  onSelectAll,
  onDeselectAll,
}: {
  selectedCount: number;
  /** A selected photo has a RAW beside its edited original, so "Delete with RAW files" applies. */
  selectedHaveRaw?: boolean;
  edits: CaptureEdits;
  /** How many photos are listed, for Select all. */
  total?: number;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
}) {
  const { t } = useTranslation();
  const actions: BarAction[] = [
    { key: "hide", label: t("species.selection.hide"), onClick: () => void edits.hideSelected() },
    ...deleteBarActions(t, selectedHaveRaw, edits.deleteSelected),
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
