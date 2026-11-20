// Photo versions on the client: which photo's Versions panel is open (components/PhotoVersions.tsx),
// how many versions each photo has (the stack badge on every photo grid) and what to call one.
import type { TFunction } from "i18next";
import type { ApiResponse } from "../api/client";
import { createCachedRoute, createStore } from "./resource";

export const photoVersionsPanel = createStore<{ captureId: string; onChange?: () => void } | null>(null);

/** Opens the Versions panel for a photo. `onChange` runs after each change so the page reloads. */
export function openPhotoVersions(captureId: string, onChange?: () => void): void {
  photoVersionsPanel.set({ captureId, onChange });
}

/** Whether the panel is open, so the photo menus inside it leave out "Versions". */
export const isPhotoVersionsOpen = () => photoVersionsPanel.get() != null;

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

// Only photos with versions are listed, so this stays small however large the library.
const versionCounts = createCachedRoute(
  "/captures/version-counts",
  (res): ReadonlyMap<string, number> => new Map(Object.entries(res.counts)),
);

/** Photo (capture id) to how many versions it has, for photos with more than one. */
export function useVersionCounts(): ReadonlyMap<string, number> {
  return versionCounts.use().data ?? NO_COUNTS;
}

/** After a link, split or a background grouping, so every badge follows. */
export const refreshVersionCounts = () => versionCounts.refresh().catch(() => undefined);

/** Bumped after any change to a photo's versions, so every open list of them reloads. */
export const versionChanges = createStore(0);

export function notifyVersionChange(): void {
  versionChanges.set(versionChanges.get() + 1);
  void refreshVersionCounts();
}

export type PhotoVersion = ApiResponse<"/captures/{id}/versions">["versions"][number];
type Named = Pick<PhotoVersion, "label" | "labelKind" | "labelSize">;

const KIND_KEYS: Record<PhotoVersion["labelKind"], string> = {
  original: "versions.label.original",
  edit: "versions.label.edit",
  export: "versions.label.export",
  print: "versions.label.print",
  bw: "versions.label.bw",
  pano: "versions.label.pano",
  enhanced: "versions.label.enhanced",
  hdr: "versions.label.hdr",
};

/** "Print 8x10", "Black and white", or the name the user gave it. */
export function versionName(t: TFunction, v: Named): string {
  if (v.label) return v.label;
  const kind = t(KIND_KEYS[v.labelKind]);
  return v.labelSize ? t("versions.label.withSize", { kind, size: v.labelSize }) : kind;
}
