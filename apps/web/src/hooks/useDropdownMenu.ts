import { useEffect, useRef, useState } from "react";
import { useEscapeToClose } from "./useEscapeToClose";

// "Which menu is open, close it on an outside click or Escape" for hover menus. `T` identifies
// the open item (a photo id, a group name, or plain `true` for a single menu).
export function useDropdownMenu<T = true>() {
  const [openKey, setOpenKey] = useState<T | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openKey === null) return;
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Element;
      // The panel is portaled to the top layer, outside the trigger's wrapper.
      if (ref.current && !ref.current.contains(target) && !target.closest?.("[data-menu-layer]")) setOpenKey(null);
    }
    document.addEventListener("click", onClickOutside);
    return () => document.removeEventListener("click", onClickOutside);
  }, [openKey]);
  useEscapeToClose(() => setOpenKey(null), openKey !== null);

  return { openKey, setOpenKey, ref, close: () => setOpenKey(null) };
}
