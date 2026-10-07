import type { RefObject } from "react";
import SpeciesPicker from "../../components/SpeciesPicker";
import { TagEditor } from "../../components/Lightbox";
import AddToAlbumButton from "../../components/AddToAlbumButton";
import InlineSpinner from "../../components/InlineSpinner";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import { pluralize } from "../../lib/pluralize";
import type { GalleryEdits } from "./useGalleryEdits";

const TRASH_NOTE = (
  <p className="text-xs text-muted">
    Deleted photos go to Trash for 7 days first, where you can still restore them. After 7 days they're gone for good
    and can't be recovered.
  </p>
);

// Select mode's bar. In the album picker it only adds to that album; otherwise it corrects the
// ID, tags, adds to any album or deletes.
export function GallerySelectBar({
  selectedIds,
  selectingAll,
  targetAlbumId,
  edits,
}: {
  selectedIds: ReadonlySet<string>;
  selectingAll: boolean;
  targetAlbumId: string | null;
  edits: GalleryEdits;
}) {
  const { bulk } = edits;
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-2 text-xs">
      <span className="shrink-0 text-muted">{selectedIds.size.toLocaleString()} selected</span>
      {selectingAll && <InlineSpinner size="xs" label="Selecting every photo" />}
      {/* Always rendered as a flex spacer so the controls don't shift with the selection. */}
      <div className="flex min-w-0 flex-1 items-center gap-6">
        {/* ID correction doesn't belong in the album picker. */}
        {!targetAlbumId && selectedIds.size > 0 && (
          <>
            <div className="flex shrink-0 items-center gap-2">
              <span className="shrink-0 text-muted">Correct ID to:</span>
              <div className="w-56">
                <SpeciesPicker placeholder="Type a species…" onSelect={(s) => bulk.reassignSelected(s.id)} />
              </div>
              {bulk.batchReassigning && <span className="shrink-0 text-muted">Reassigning…</span>}
            </div>
            <span aria-hidden className="h-4 w-px shrink-0 bg-line" />
            <div className="flex shrink-0 items-center gap-2">
              <span className="shrink-0 text-muted">Add tag:</span>
              <div className="w-48">
                <TagEditor tags={bulk.tags} existingTags={edits.tagOptions} compact onChange={bulk.changeTags} />
              </div>
            </div>
            {bulk.tags.length > 0 && (
              <Button size="sm" onClick={edits.exitSelectMode} className="shrink-0">
                Done
              </Button>
            )}
          </>
        )}
      </div>
      {targetAlbumId ? (
        <Button
          size="sm"
          onClick={edits.addSelectedToTargetAlbum}
          disabled={selectedIds.size === 0}
          loading={edits.addingToTargetAlbum}
          className="shrink-0"
        >
          {edits.addingToTargetAlbum ? "Adding…" : `Add ${selectedIds.size || ""} to album`}
        </Button>
      ) : (
        <AddToAlbumButton captureIds={[...selectedIds]} onAdded={edits.exitSelectMode} />
      )}
      <Button
        variant="danger"
        size="sm"
        onClick={() => edits.batch.setOpen(true)}
        disabled={selectedIds.size === 0}
        className="shrink-0"
      >
        Delete selected
      </Button>
    </div>
  );
}

// "Delete this photo?" from a tile's menu, and "Delete N photos?" for the selection.
export function GalleryDeleteDialogs({
  edits,
  singleKind,
  selectedCount,
  batchNoun,
  selectedHaveRaw,
  deleteButtonRef,
  batchDeleteButtonRef,
}: {
  edits: GalleryEdits;
  singleKind: "image" | "video" | undefined;
  selectedCount: number;
  batchNoun: string;
  selectedHaveRaw: boolean;
  deleteButtonRef: RefObject<HTMLButtonElement | null>;
  batchDeleteButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { single, batch, deleting } = edits;
  return (
    <>
      <Modal
        open={!!single.captureId}
        onClose={() => single.request(null)}
        title={`Delete this ${singleKind === "video" ? "video" : "photo"}?`}
        initialFocusRef={deleteButtonRef}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => single.request(null)}>
              Cancel
            </Button>
            <Button
              ref={deleteButtonRef}
              variant="danger"
              size="sm"
              loading={deleting}
              onClick={() => single.captureId && single.confirm(single.captureId)}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        {TRASH_NOTE}
      </Modal>

      <Modal
        open={batch.open}
        onClose={batch.close}
        title={`Delete ${pluralize(selectedCount, batchNoun)}?`}
        initialFocusRef={batchDeleteButtonRef}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={batch.close}>
              Cancel
            </Button>
            <Button ref={batchDeleteButtonRef} variant="danger" size="sm" loading={deleting} onClick={batch.confirm}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      >
        {TRASH_NOTE}
        {selectedHaveRaw && (
          <label className="mt-3 flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={batch.deleteRawToo}
              onChange={(e) => batch.setDeleteRawToo(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Also delete the matching RAW file when this is permanently removed
          </label>
        )}
      </Modal>
    </>
  );
}

// Select mode's bar under the "Hidden" filter: photos a culling app rejected, imported hidden.
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
  return (
    <div className="flex items-center gap-3 border-b border-line bg-surface-muted px-6 py-2 text-xs">
      <span className="shrink-0 text-muted">{selectedIds.size.toLocaleString()} selected</span>
      {selectingAll && <InlineSpinner size="xs" label="Selecting every photo" />}
      <span className="min-w-0 flex-1 text-muted">
        Hidden photos were rejected in your culling app. Unhiding adds them to your gallery and life list.
      </span>
      <Button size="sm" onClick={onUnhide} disabled={selectedIds.size === 0} loading={unhiding} className="shrink-0">
        {unhiding ? "Unhiding…" : "Unhide selected"}
      </Button>
    </div>
  );
}
