// One look for every dropdown and right-click menu. The panel's width and positioning stay with
// each caller, since they vary by where the menu opens.
export const MENU_PANEL = "rounded-md border border-line bg-surface py-1 text-xs shadow-lg";

export const MENU_ITEM =
  "block w-full px-3 py-1.5 text-left text-xs text-ink hover:bg-surface-muted disabled:opacity-50";

// Destructive actions go last, after a separator.
export const MENU_ITEM_DANGER =
  "block w-full px-3 py-1.5 text-left text-xs text-red-600 hover:bg-surface-muted disabled:opacity-50 dark:text-red-400";

export const MENU_SEPARATOR = "my-1 border-t border-line";
