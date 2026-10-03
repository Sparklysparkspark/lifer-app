import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { isMac } from "../lib/platform";

// Loaded on first open, so the palette (and the settings list it imports) costs nothing at startup.
const CommandPalette = lazy(() => import("../components/CommandPalette"));
// The palette closes before this opens, so it lives here rather than inside the palette.
const AddOtherTaxaModal = lazy(() => import("../components/AddOtherTaxaModal"));

const CommandPaletteContext = createContext<{ open: () => void }>({ open: () => {} });

/** Cmd+K on Mac, Ctrl+K elsewhere, from anywhere (the modifier makes it safe inside a text field). */
export function isCommandPaletteShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac = isMac): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const [inatSearch, setInatSearch] = useState<{ query: string; regionId: string | null } | null>(null);
  const openInatSearch = useCallback((query: string, regionId: string | null) => setInatSearch({ query, regionId }), []);

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
          <AddOtherTaxaModal initialQuery={inatSearch.query} initialRegionId={inatSearch.regionId} onClose={() => setInatSearch(null)} />
        </Suspense>
      )}
    </CommandPaletteContext.Provider>
  );
}

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}
