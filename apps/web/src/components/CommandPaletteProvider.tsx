import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { CommandPaletteContext, isCommandPaletteShortcut } from "../hooks/useCommandPalette";

// Loaded on first open, so the palette (and the settings list it imports) costs nothing at startup.
const CommandPalette = lazy(() => import("./CommandPalette"));
// The palette closes before this opens, so it lives here rather than inside the palette.
const AddOtherTaxaModal = lazy(() => import("./AddOtherTaxaModal"));

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const [inatSearch, setInatSearch] = useState<{ query: string; regionId: string | null } | null>(null);
  const openInatSearch = useCallback(
    (query: string, regionId: string | null) => setInatSearch({ query, regionId }),
    [],
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || !isCommandPaletteShortcut(e)) return;
      e.preventDefault();
      setIsOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ open }), [open]);
  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {isOpen && (
        <Suspense fallback={null}>
          <CommandPalette onClose={() => setIsOpen(false)} onInatSearch={openInatSearch} />
        </Suspense>
      )}
      {inatSearch && (
        <Suspense fallback={null}>
          <AddOtherTaxaModal
            initialQuery={inatSearch.query}
            initialRegionId={inatSearch.regionId}
            onClose={() => setInatSearch(null)}
          />
        </Suspense>
      )}
    </CommandPaletteContext.Provider>
  );
}
