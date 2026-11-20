// One look for every dropdown and right-click menu. The panel's width and positioning stay with
// each caller, since they vary by where the menu opens.
export const MENU_PANEL = "overflow-hidden rounded-panel border border-line bg-surface py-1 text-footnote shadow-lg";

// Focus is the one highlight: MenuPanel moves focus to the item the mouse moves over.
export const MENU_ITEM =
  "block w-full px-3 py-1.5 text-left text-footnote text-ink focus:bg-surface-muted focus-visible:outline-offset-[-2px] disabled:opacity-50";

// Destructive actions go last, after a separator.
export const MENU_ITEM_DANGER =
  "block w-full px-3 py-1.5 text-left text-footnote text-red-600 focus:bg-surface-muted focus-visible:outline-offset-[-2px] disabled:opacity-50 dark:text-red-400";

export const MENU_SEPARATOR = "my-1 border-t border-line";
