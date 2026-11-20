import { createContext, useContext } from "react";
import { isMac } from "../lib/platform";
import { matches } from "../lib/keymap";

// Provided by components/CommandPaletteProvider.tsx.
export const CommandPaletteContext = createContext<{ open: () => void }>({ open: () => {} });

/** Cmd+K on Mac, Ctrl+K elsewhere, from anywhere (the modifier makes it safe inside a text field). */
export function isCommandPaletteShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac = isMac,
): boolean {
  // Fields one by one: a DOM event's are prototype getters, which a spread doesn't copy.
  const { key, metaKey, ctrlKey, altKey, shiftKey } = e;
  return matches({ key, code: "", metaKey, ctrlKey, altKey, shiftKey }, "palette", mac);
}

export function useCommandPalette() {
  return useContext(CommandPaletteContext);
}
