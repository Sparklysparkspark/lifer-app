// Names that may be a RAW, for folder scans. A .tif/.tiff is a RAW only when it holds sensor data
// (formats.ts isRawFile); an edited TIFF is a photo, so new code should call isRawFile instead.
export const RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".raf",
  ".rw2",
  ".orf",
  ".dng",
  ".pef",
  ".srw",
  ".tif",
  ".tiff",
]);
