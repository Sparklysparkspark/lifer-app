import { useRef } from "react";
import { enqueueUploads } from "../lib/uploadQueue";
import { PHOTO_ACCEPT, VIDEO_ACCEPT } from "../lib/photoFormats";

// Queues photos (JPEG, PNG, WebP, TIFF, HEIC) and videos (MP4, MOV) for background upload and
// closes; progress shows in the global upload banner. RAWs go through RawUpload instead.
export default function UploadDropzone({
  speciesId,
  volumeId,
  tripId,
  onUploaded,
  onClose,
}: {
  speciesId: string;
  /** External drive to save into, or "" for the primary drive (see VolumeDestinationPicker). */
  volumeId: string;
  /** Saves into this trip's folder (see enqueueUploads). */
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
      // Refetch per file so each photo appears as soon as its own upload finishes.
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
        accept={`${PHOTO_ACCEPT},${VIDEO_ACCEPT}`}
        className="hidden"
        id="upload-input"
        onChange={(e) => handleUpload(Array.from(e.target.files ?? []))}
      />
      <span className="text-sm text-muted hover:underline">Choose photos or videos…</span>
    </div>
  );
}
