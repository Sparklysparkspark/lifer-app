// Mirrors packages/core/src/uploads/formats.ts PHOTO_FORMATS. Keep the two in sync.
import { extname } from "./rawExtensions";

export type PhotoFormat = "jpeg" | "png" | "webp" | "tiff" | "heic";

interface FormatInfo {
  mimeTypes: string[];
  extensions: string[];
  /** Browsers can show it; otherwise the import screen shows the server's preview. */
  browserDisplayable: boolean;
}

export const PHOTO_FORMATS: Record<PhotoFormat, FormatInfo> = {
  jpeg: {
    mimeTypes: ["image/jpeg", "image/jpg", "image/pjpeg"],
    extensions: [".jpg", ".jpeg", ".jpe"],
    browserDisplayable: true,
  },
  png: { mimeTypes: ["image/png"], extensions: [".png"], browserDisplayable: true },
  webp: { mimeTypes: ["image/webp"], extensions: [".webp"], browserDisplayable: true },
  tiff: {
    mimeTypes: ["image/tiff", "image/tif", "image/x-tiff"],
    extensions: [".tif", ".tiff"],
    browserDisplayable: false,
  },
  heic: {
    mimeTypes: ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"],
    extensions: [".heic", ".heif", ".hif"],
    browserDisplayable: false,
  },
};

export const PHOTO_MIME_TYPES: string[] = Object.values(PHOTO_FORMATS).flatMap((f) => f.mimeTypes);
export const PHOTO_EXTENSIONS: string[] = Object.values(PHOTO_FORMATS).flatMap((f) => f.extensions);

export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"];
export const VIDEO_EXTENSIONS = [".mp4", ".mov"];

// Browsers send "" or application/octet-stream for types they don't know (HEIC on most desktops).
const GENERIC_MIME_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** The photo format a file claims: its MIME type, or its name when the browser didn't know the type. */
export function photoFormatOf(file: { name: string; type: string }): PhotoFormat | null {
  const mime = file.type.split(";")[0].trim().toLowerCase();
  const entries = Object.entries(PHOTO_FORMATS) as [PhotoFormat, FormatInfo][];
  if (!GENERIC_MIME_TYPES.has(mime)) return entries.find(([, info]) => info.mimeTypes.includes(mime))?.[0] ?? null;
  const ext = extname(file.name);
  return entries.find(([, info]) => info.extensions.includes(ext))?.[0] ?? null;
}

/** True for a JPEG, PNG or WebP, which an <img> can show straight from the File. */
export function isBrowserDisplayable(file: { name: string; type: string }): boolean {
  const format = photoFormatOf(file);
  return format != null && PHOTO_FORMATS[format].browserDisplayable;
}

export function isVideoFile(file: { name: string; type: string }): boolean {
  return VIDEO_MIME_TYPES.includes(file.type) || VIDEO_EXTENSIONS.includes(extname(file.name));
}

/** accept attribute values. Extensions are listed too, since some browsers don't know HEIC's MIME type. */
export const PHOTO_ACCEPT = [...PHOTO_MIME_TYPES, ...PHOTO_EXTENSIONS].join(",");
export const VIDEO_ACCEPT = [...VIDEO_MIME_TYPES, ...VIDEO_EXTENSIONS].join(",");
