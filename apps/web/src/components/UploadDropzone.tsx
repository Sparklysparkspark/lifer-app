import { useTranslation } from "react-i18next";
import FilePickArea from "./FilePickArea";
import { enqueueUploads } from "../lib/uploadQueue";
import { PHOTO_ACCEPT, VIDEO_ACCEPT, isVideoFile, photoFormatOf } from "../lib/photoFormats";

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
  const { t } = useTranslation();

  function handleUpload(picked: File[]) {
    // A drop or a folder brings whatever is there; only photos and videos are queued.
    const files = picked.filter((f) => photoFormatOf(f) || isVideoFile(f));
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
    <FilePickArea
      prompt={t("upload.choosePhotosOrVideos")}
      accept={`${PHOTO_ACCEPT},${VIDEO_ACCEPT}`}
      onFiles={(files) => handleUpload(Array.from(files))}
    />
  );
}
