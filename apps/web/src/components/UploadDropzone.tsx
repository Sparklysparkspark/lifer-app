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
export default function UploadDropzone({ speciesId, onUploaded }: { speciesId: string; onUploaded: () => void }) {
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<FileUploadResult[] | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
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

  async function handleUpload() {
    if (pendingFiles.length === 0) return;
    setResults(null);
    setUploading(true);
    try {
      // Independent captures — no reason one slow/failed file should hold up the rest, so
      // they all go concurrently (same pattern as RawUpload's batch endpoint) rather than
      // one at a time.
      const outcomes = await Promise.all(pendingFiles.map(uploadOne));
      setResults(outcomes.length > 1 || !outcomes[0].ok ? outcomes : null);
      if (outcomes.some((o) => o.ok)) onUploaded();
      if (outcomes.every((o) => o.ok)) setPendingFiles([]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const successCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    // The whole dashed box opens the file picker, not just the "Choose photos…" text.
    // Handled via an explicit onClick + fileInputRef rather than making the whole box a
    // <label>, since a <label> wrapping a nested <button> has inconsistent click-bubbling
    // behavior across browsers — this way the Upload button's own click handler can cleanly
    // stop the box's click from also reopening the file picker.
    <div
      onClick={() => fileInputRef.current?.click()}
      className="cursor-pointer rounded-lg border-2 border-dashed border-stone-300 p-6 text-center transition-colors hover:bg-stone-200"
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png"
        className="hidden"
        id="upload-input"
        onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
      />
      <span className="text-sm text-stone-600 hover:underline">
        {pendingFiles.length === 0
          ? "Choose photos…"
          : pendingFiles.length === 1
            ? pendingFiles[0].name
            : `${pendingFiles.length} photos selected`}
      </span>
      {pendingFiles.length > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleUpload();
          }}
          disabled={uploading}
          className="mt-3 block w-full rounded-md bg-stone-800 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
        >
          {uploading ? "Uploading…" : pendingFiles.length === 1 ? "Upload" : `Upload ${pendingFiles.length} photos`}
        </button>
      )}
      {results && (
        <div onClick={(e) => e.stopPropagation()} className="mt-2 space-y-1 text-left text-xs">
          <p className="font-medium text-stone-600">
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
