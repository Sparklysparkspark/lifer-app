// .tif/.tiff are included alongside the camera-specific formats — some cameras/scanners and
// RAW converters (e.g. a DNG converted to a flattened TIFF, or certain medium-format backs)
// export as TIFF rather than a vendor RAW extension, and it is still the real, unprocessed/
// high-bit-depth file in the same sense the RAW-matching feature cares about.
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
