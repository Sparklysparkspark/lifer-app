import { useRef, useState } from "react";
import { api, ApiError } from "../api/client";

interface FileUploadResult {
  name: string;
  ok: boolean;
  error?: string;
}

// Simple upload control: pick one or more JPEGs/PNGs and upload them in "store" mode. RAW
// siblings are handled separately by RawUpload's folder-based matcher (by filename + EXIF),
// so this component doesn't need to offer a single-photo "attach a RAW" flow. It also avoids
// any platform-specific file-picking (e.g. shelling out to Finder on macOS), since this
// control needs to work on any OS a self-hosted server's client might run on.
export default function UploadDropzone({
  speciesId,
  onUploaded,
  onClose,
}: {
  speciesId: string;
  onUploaded: () => void;
  onClose?: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<FileUploadResult[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function uploadOne(file: File): Promise<FileUploadResult> {
    try {
      const form = new FormData();
      form.append("mode", "store");
      form.append("speciesId", speciesId);
      form.append("file", file);
      await api.post("/uploads", form);
      return { name: file.name, ok: true };
    } catch (err) {
      return { name: file.name, ok: false, error: err instanceof ApiError ? err.message : "Upload failed" };
    }
  }

  async function handleUpload(files: File[]) {
    if (files.length === 0) return;
    setResults(null);
    setUploading(true);
    try {
      // Independent captures — no reason one slow/failed file should hold up the rest, so
      // they all go concurrently (same pattern as RawUpload's batch endpoint) rather than
      // one at a time.
      const outcomes = await Promise.all(files.map(uploadOne));
      if (outcomes.some((o) => o.ok)) onUploaded();
      if (outcomes.every((o) => o.ok)) {
        onClose?.();
      } else {
        setResults(outcomes);
      }
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const successCount = results?.filter((r) => r.ok).length ?? 0;

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
      <span className="text-sm text-muted hover:underline">{uploading ? "Uploading…" : "Choose photos…"}</span>
      {results && (
        <div onClick={(e) => e.stopPropagation()} className="mt-2 space-y-1 text-left text-xs">
          <p className="font-medium text-muted">
            {successCount} of {results.length} uploaded
          </p>
          {results
            .filter((r) => !r.ok)
            .map((r, i) => (
              <p key={i} className="text-red-600">
                {r.name}: {r.error}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
