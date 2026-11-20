// How the Collection is arranged, remembered between launches (N3): the region last chosen, what to show,
// the order, grouping and card size, and the extra filters. One place, shared with the filter sheets.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp } from "../app/AppContext";
import { getMeta, setMeta } from "../store/meta";
import { DEFAULT_VIEW, type CollectionView } from "./model";

export * from "./model";

interface Ctx {
  view: CollectionView;
  update(patch: Partial<CollectionView>): void;
  /** Clears show and the extra filters, keeps region and layout. */
  clearFilters(): void;
}

const ViewCtx = createContext<Ctx | null>(null);
const KEY = "collectionView";

export function CollectionViewProvider({ children }: { children: ReactNode }) {
  const { db } = useApp();
  const [view, setView] = useState<CollectionView>(DEFAULT_VIEW);
  const loaded = useRef(false);
  useEffect(() => {
    void getMeta<Partial<CollectionView>>(db, KEY).then((saved) => {
      if (saved) setView((v) => ({ ...v, ...saved }));
      loaded.current = true;
    });
  }, [db]);
  const update = useCallback(
    (patch: Partial<CollectionView>) =>
      setView((v) => {
        const next = { ...v, ...patch };
        if (patch.region !== undefined && patch.region && patch.region !== v.region)
          next.recent = [patch.region, ...v.recent.filter((r) => r !== patch.region)].slice(0, 3);
        void setMeta(db, KEY, next);
        return next;
      }),
    [db],
  );
  // Development driver only (screenshots): lets a script set the view without tapping.
  if (__DEV__) (globalThis as { __liferView?: unknown }).__liferView = { update };
  const clearFilters = useCallback(() => update({ show: "all", tiers: [], vagrants: true, year: null }), [update]);
  const value = useMemo(() => ({ view, update, clearFilters }), [view, update, clearFilters]);
  return <ViewCtx.Provider value={value}>{children}</ViewCtx.Provider>;
}

export function useCollectionView(): Ctx {
  const c = useContext(ViewCtx);
  if (!c) throw new Error("CollectionViewProvider is missing");
  return c;
}
