import { useState, type FormEvent } from "react";
import Button from "./Button";
import Modal from "./Modal";
import { TagEditor } from "./Lightbox";
import RegionBrowser from "./RegionBrowser";
import SpeciesPicker from "./SpeciesPicker";

/** What the dialogs read from the photo; pages map their own row shape to this. */
export interface EditedCapture {
  tags: string[];
  locationLabel?: string | null;
  regionId?: string | null;
}

export type CaptureEdit = "reassign" | "tagSpecies" | "location" | "tags";

// A photo menu's longer edits, each in its own dialog so the menu stays a plain list of actions. A
// page passes the handlers for the edits its menu offers.
export default function CaptureEditModal({
  edit,
  capture,
  onClose,
  onReassign,
  onTagSpecies,
  onSaveLocation,
  tagOptions,
  onTagsChange,
}: {
  edit: CaptureEdit;
  capture: EditedCapture;
  tagOptions: string[];
  /** Tags save as they're added or removed, like everywhere else tags are edited. */
  onTagsChange: (tags: string[]) => void;
  onClose: () => void;
  onReassign: (speciesId: string) => void;
  onTagSpecies?: (speciesId: string) => void;
  onSaveLocation?: (label: string, regionId: string | null) => void;
}) {
  if (edit === "tags")
    return (
      <Modal
        open
        onClose={onClose}
        title="Tags"
        footer={
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <TagEditor compact tags={capture.tags} existingTags={tagOptions} onChange={onTagsChange} />
      </Modal>
    );
  if (edit === "location")
    return (
      <LocationModal
        capture={capture}
        onClose={onClose}
        onSave={(label, regionId) => onSaveLocation?.(label, regionId)}
      />
    );
  const reassign = edit === "reassign";
  return (
    <Modal
      open
      onClose={onClose}
      title={reassign ? "Correct the ID" : "Also features another species"}
      size="md"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <p className="mb-3 text-sm text-muted">
        {reassign
          ? "Moves this photo to the species it really shows."
          : "Keeps this photo here and also lists it under the other species."}
      </p>
      <SpeciesPicker
        autoFocus
        inline
        placeholder="Search species"
        onSelect={(s) => {
          if (reassign) onReassign(s.id);
          else onTagSpecies?.(s.id);
          onClose();
        }}
      />
    </Modal>
  );
}

function LocationModal({
  capture,
  onClose,
  onSave,
}: {
  capture: EditedCapture;
  onClose: () => void;
  onSave: (label: string, regionId: string | null) => void;
}) {
  const [label, setLabel] = useState(capture.locationLabel ?? "");
  const [regionId, setRegionId] = useState(capture.regionId ?? null);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(label, regionId);
    onClose();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Location"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="capture-location-form">
            Save
          </Button>
        </>
      }
    >
      <form id="capture-location-form" onSubmit={submit} className="space-y-4">
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Place name</span>
          <input
            type="text"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Prince George"
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </label>
        <div className="text-sm">
          <p className="mb-1 text-muted">Region</p>
          <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
        </div>
      </form>
    </Modal>
  );
}
