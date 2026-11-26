// How the Collection and the Gallery are shown, remembered between launches (N3): the region last chosen,
// the View choices and the filters. One place, shared by each screen and the one Filters sheet.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useApp } from "../app/AppContext";
import { getMeta, setMeta } from "../store/meta";
import {
  CLEARED_FILTERS,
  CLEARED_GALLERY,
  DEFAULT_GALLERY,
  DEFAULT_VIEW,
  loadView,
  type CollectionView,
  type GalleryView,
} from "./model";

export * from "./model";

interface Ctx {
  view: CollectionView;
  update(patch: Partial<CollectionView>): void;
  /** Clears the filters, keeps region and View choices. */
  clearFilters(): void;
  gallery: GalleryView;
  updateGallery(patch: Partial<GalleryView>): void;
  clearGalleryFilters(): void;
}

const ViewCtx = createContext<Ctx | null>(null);
const KEY = "collectionView";
const GALLERY_KEY = "galleryView";

export function CollectionViewProvider({ children }: { children: ReactNode }) {
  const { db } = useApp();
  const [view, setView] = useState<CollectionView>(DEFAULT_VIEW);
  const [gallery, setGallery] = useState<GalleryView>(DEFAULT_GALLERY);
  useEffect(() => {
    void getMeta<Partial<CollectionView>>(db, KEY).then(
      (saved) => saved && setView((v) => loadView({ ...v, ...saved })),
    );
    void getMeta<Partial<GalleryView>>(db, GALLERY_KEY).then(
      (saved) => saved && setGallery((v) => ({ ...v, ...saved })),
    );
  }, [db]);
  const update = useCallback(
    (patch: Partial<CollectionView>) =>
      setView((v) => {
        const next = { ...v, ...patch };
        if (patch.region !== undefined && patch.region !== v.region) {
          // Photos taken names the region, so a new region starts from Anywhere.
          next.photosTaken = "anywhere";
          if (patch.region) next.recent = [patch.region, ...v.recent.filter((r) => r !== patch.region)].slice(0, 3);
        }
        void setMeta(db, KEY, next);
        return next;
      }),
    [db],
  );
  const updateGallery = useCallback(
    (patch: Partial<GalleryView>) =>
      setGallery((v) => {
        const next = { ...v, ...patch };
        void setMeta(db, GALLERY_KEY, next);
        return next;
      }),
    [db],
  );
  // Development driver only (screenshots): lets a script set the view without tapping.
  if (__DEV__) (globalThis as { __liferView?: unknown }).__liferView = { update };
  const clearFilters = useCallback(() => update(CLEARED_FILTERS), [update]);
  const clearGalleryFilters = useCallback(() => updateGallery(CLEARED_GALLERY), [updateGallery]);
  const value = useMemo(
    () => ({ view, update, clearFilters, gallery, updateGallery, clearGalleryFilters }),
    [view, update, clearFilters, gallery, updateGallery, clearGalleryFilters],
  );
  return <ViewCtx.Provider value={value}>{children}</ViewCtx.Provider>;
}

export function useCollectionView(): Ctx {
  const c = useContext(ViewCtx);
  if (!c) throw new Error("CollectionViewProvider is missing");
  return c;
}
