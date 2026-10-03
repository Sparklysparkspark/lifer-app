// Mirrors apps/api/src/uploads/formats.ts VENDOR_RAW_EXTENSIONS and uploads/rawExtensions.ts.
// Keep them in sync.
export const VENDOR_RAW_EXTENSIONS = new Set([".cr2", ".cr3", ".nef", ".nrw", ".arw", ".raf", ".rw2", ".orf", ".dng", ".pef", ".srw"]);

// Names the RAW pickers accept. A TIFF may hold sensor data (the server decides), so it's offered
// there too; everywhere else a TIFF is an edited photo.
export const RAW_EXTENSIONS = new Set([...VENDOR_RAW_EXTENSIONS, ".tif", ".tiff"]);

export function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/** A camera RAW by its extension. A TIFF isn't one here: the server tells a CFA TIFF apart. */
export function isRawFile(filename: string): boolean {
  return VENDOR_RAW_EXTENSIONS.has(extname(filename));
}
