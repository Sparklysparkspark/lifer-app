import { useRef } from "react";
import { enqueueUploads } from "../lib/uploadQueue";

// Simple upload control: pick one or more JPEGs/PNGs and queue them in "store" mode. The
// actual upload happens in the background via lib/uploadQueue — this component just enqueues
// and gets out of the way (closing immediately), so the user can keep browsing or start
// another upload elsewhere while these finish. Progress/errors surface via the global banner
// (UploadQueueBanner in App.tsx), not here. RAW siblings are handled separately by RawUpload's
// folder-based matcher (by filename + EXIF); the destination drive picker itself lives one
// level up (VolumeDestinationPicker), shared between this and RawUpload.
export default function UploadDropzone({
  speciesId,
  volumeId,
  tripId,
  onUploaded,
  onClose,
}: {
  speciesId: string;
  /** Registered external drive to save into, or "" for the primary drive — see
   *  VolumeDestinationPicker, rendered by the parent dialog above both upload controls. */
  volumeId: string;
  /** "Build a Trip" destination override — see enqueueUploads' own tripId doc comment. */
  tripId?: string;
  onUploaded: () => void;
  onClose?: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleUpload(files: File[]) {
    if (files.length === 0) return;
    enqueueUploads(speciesId, files, {
      volumeId: volumeId || undefined,
      tripId,
      targetsExternalDrive: Boolean(volumeId),
      // Refreshes after EACH photo settles, not just once the whole batch finishes — a
      // multi-photo upload otherwise showed shrinking placeholder squares while every real
      // photo waited to pop in all at once at the very end, instead of each one appearing as
      // soon as its own upload was actually done. onUploaded (a plain refetch) is safe to call
      // this often — it's just a GET, not a mutation.
      onFileSettled: onUploaded,
      onBatchSettled: onUploaded,
    });
    onClose?.();
  }

  return (
    // The whole dashed box opens the file picker, not just the "Choose photos…" text.
    <div
      onClick={() => fileInputRef.current?.click()}
      className="cursor-pointer rounded-lg border-2 border-dashed border-line p-6 text-center transition-colors hover:bg-surface-muted"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png"
        className="hidden"
        id="upload-input"
        onChange={(e) => handleUpload(Array.from(e.target.files ?? []))}
      />
      <span className="text-sm text-muted hover:underline">Choose photos…</span>
    </div>
  );
}
