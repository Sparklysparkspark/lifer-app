import type { RefObject } from "react";
import SpeciesPicker from "../../components/SpeciesPicker";
import { TagEditor } from "../../components/Lightbox";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import { pluralize } from "../../lib/pluralize";
import type { CaptureEdits } from "./useCaptureEdits";

// Select mode's bar: correct the ID or add tags for every selected photo, or delete them.
export function CaptureSelectBar({ selectedCount, edits }: { selectedCount: number; edits: CaptureEdits }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-line bg-surface-muted px-3 py-2 text-xs">
      <span className="shrink-0 text-muted">{selectedCount} selected</span>
      {selectedCount > 0 && (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-muted">Correct ID to:</span>
          <div className="w-56">
            <SpeciesPicker placeholder="Type a species…" onSelect={(s) => edits.reassignSelected(s.id)} />
          </div>
          {edits.batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
          <span className="shrink-0 text-muted">Add tag:</span>
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
              Done
            </Button>
          )}
        </div>
      )}
      <Button
        variant="danger"
        size="sm"
        className="shrink-0"
        onClick={() => edits.deleteDialog.setOpen(true)}
        disabled={selectedCount === 0}
      >
        Delete selected
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
  noun: string;
  selectedHaveRaw: boolean;
  deleteButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Modal
      open={dialog.open}
      onClose={dialog.cancel}
      title={`Delete ${pluralize(count, noun)}?`}
      onKeyDown={dialog.onKeyDown}
      initialFocusRef={deleteButtonRef}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={dialog.cancel} disabled={dialog.deleting}>
            Cancel
          </Button>
          <Button
            ref={deleteButtonRef}
            variant="danger"
            size="sm"
            onClick={() => void dialog.confirm()}
            loading={dialog.deleting}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted">
        Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for
        good and can't be recovered.
      </p>
      {selectedHaveRaw && (
        <label className="mt-3 flex items-center gap-2 text-xs text-ink">
          <input
            type="checkbox"
            checked={dialog.deleteRawToo}
            onChange={(e) => dialog.setDeleteRawToo(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Also delete the matching RAW file when this is permanently removed
        </label>
      )}
    </Modal>
  );
}
