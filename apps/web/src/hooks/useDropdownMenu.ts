import { useEffect, useRef, useState } from "react";

// The exact "which key is currently open, and close it on any click outside" bookkeeping that
// was independently reimplemented per page for every hover "⋯" menu (Gallery's photo menu,
// SpeciesDetailPage's photo menu, OfflinePacksPage's group-tab dropdown, and others) — genuinely
// identical logic each time, just copy-pasted. `T` is whatever key identifies "which item's menu
// is open" (a photo id, a capture id, a group name, or plain `true` for a single menu with no
// per-item identity).
export function useDropdownMenu<T = true>() {
  const [openKey, setOpenKey] = useState<T | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openKey === null) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenKey(null);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [openKey]);

  return { openKey, setOpenKey, ref, close: () => setOpenKey(null) };
}
