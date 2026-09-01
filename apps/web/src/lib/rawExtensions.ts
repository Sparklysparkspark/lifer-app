// Mirrors apps/api/src/uploads/rawExtensions.ts — kept as its own small copy rather than a
// shared package import (same tradeoff this monorepo already accepts elsewhere for a tiny,
// rarely-changing constant, e.g. species/embeddings.ts's duplicated model config).
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

export function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function isRawFile(filename: string): boolean {
  return RAW_EXTENSIONS.has(extname(filename));
}
