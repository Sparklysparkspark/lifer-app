import { createContext, useContext } from "react";
import { isMac } from "../lib/platform";

// Provided by components/CommandPaletteProvider.tsx.
export const CommandPaletteContext = createContext<{ open: () => void }>({ open: () => {} });

/** Cmd+K on Mac, Ctrl+K elsewhere, from anywhere (the modifier makes it safe inside a text field). */
export function isCommandPaletteShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac = isMac,
): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}
