// The single keyboard registry (docs/plans/keyboard-shortcuts.md). Components match events and
// read labels through it; none parses keys on its own.
import { isMac } from "./platform";

// Chord grammar: "Mod+Shift+I". Mod is Cmd on macOS, Ctrl elsewhere. "Digit0" and "BracketLeft"
// style tokens match event.code (position, so AZERTY works); anything else matches event.key.
export type KeyAction =
  | "next"
  | "previous"
  | "nextGroup"
  | "previousGroup"
  | "open"
  | "backToGrid"
  | "peek"
  | "compare"
  | "fullScreen"
  | "info"
  | "close"
  | "palette"
  | "find"
  | "settings"
  | "import"
  | "shortcuts"
  | "zoomToggle"
  | "zoomFit"
  | "zoomIn"
  | "zoomOut"
  | "cardLarger"
  | "cardSmaller"
  | "rate1"
  | "rate2"
  | "rate3"
  | "rate4"
  | "rate5"
  | "rateClear"
  | "changeSpecies"
  | "feature"
  | "selectAll"
  | "selectNone"
  | "trash"
  | "confirm"
  | "export"
  | "playPause"
  | "skipBack"
  | "skipForward"
  | "frameBack"
  | "frameForward"
  | "undoLocation"
  | "regionOut"
  | "regionReset"
  | "rateClearNext"
  | "rate1Next"
  | "rate2Next"
  | "rate3Next"
  | "rate4Next"
  | "rate5Next"
  | "toggleSidebar"
  | "page1"
  | "page2"
  | "page3"
  | "page4"
  | "page5"
  | "reviewConfirm"
  | "reviewPick"
  | "reviewNotSure"
  | "reviewNext"
  | "reviewPrevious"
  | "versionsShow"
  | "versionPrevious"
  | "versionNext"
  | "versionUseAsPhoto"
  | "versionSplitOut"
  | "versionLinkTo"
  | "versionReviewLinkAll"
  | "versionReviewLink"
  | "versionReviewDismiss"
  | "compareImport"
  | "compareSpecies"
  | "importUndo"
  | "importClear"
  | "importNoAnimal"
  | WidgetAction;

/** Keys a focused control uses for itself (lists, menus, fields, sliders). They follow the
 *  platform, never clash with page shortcuts, and stay out of the shortcut sheet. */
export type WidgetAction =
  "listNext" | "listPrevious" | "listFirst" | "listLast" | "stepUp" | "stepDown" | "choose" | "toggle" | "focusCycle";

// "dialog" and "widget" only fire while one has focus; the rest are where the page or viewer is.
export type KeyScope = "global" | "dialog" | "widget" | "gallery" | "photo" | "video" | "import" | "map" | "review";

interface Entry {
  scope: KeyScope;
  // Alternatives; every one triggers the action. The first is shown in labels.
  chords: string[];
  // Mac-only replacement for `chords`, when the platforms differ.
  mac?: string[];
  // The desktop menu binds it; in a browser the chord belongs to the browser (tabs).
  desktopOnly?: true;
}

export const KEYMAP: Record<KeyAction, Entry> = {
  next: { scope: "photo", chords: ["ArrowRight"] },
  previous: { scope: "photo", chords: ["ArrowLeft"] },
  nextGroup: { scope: "import", chords: ["ArrowDown"] },
  previousGroup: { scope: "import", chords: ["ArrowUp"] },
  open: { scope: "gallery", chords: ["Enter", "E"] },
  backToGrid: { scope: "photo", chords: ["G", "Escape"] },
  peek: { scope: "gallery", chords: [" "] },
  compare: { scope: "gallery", chords: ["C"] },
  fullScreen: { scope: "photo", chords: ["F"] },
  info: { scope: "photo", chords: ["I", "Mod+I"] },
  close: { scope: "dialog", chords: ["Escape"] },
  palette: { scope: "global", chords: ["Mod+K"] },
  find: { scope: "global", chords: ["Mod+F"] },
  settings: { scope: "global", chords: ["Mod+,"] },
  import: { scope: "global", chords: ["Mod+Shift+I"] },
  shortcuts: { scope: "global", chords: ["?"] },
  zoomToggle: { scope: "photo", chords: ["Z"] },
  zoomFit: { scope: "photo", chords: ["Mod+Digit0"] },
  zoomIn: { scope: "photo", chords: ["Mod+=", "+", "="] },
  zoomOut: { scope: "photo", chords: ["Mod+-", "-"] },
  cardLarger: { scope: "gallery", chords: ["="] },
  cardSmaller: { scope: "gallery", chords: ["-"] },
  rate1: { scope: "photo", chords: ["Digit1"] },
  rate2: { scope: "photo", chords: ["Digit2"] },
  rate3: { scope: "photo", chords: ["Digit3"] },
  rate4: { scope: "photo", chords: ["Digit4"] },
  rate5: { scope: "photo", chords: ["Digit5"] },
  rateClear: { scope: "photo", chords: ["Digit0"] },
  changeSpecies: { scope: "photo", chords: ["S"] },
  feature: { scope: "photo", chords: ["K"] },
  selectAll: { scope: "gallery", chords: ["Mod+A"] },
  selectNone: { scope: "gallery", chords: ["Mod+Shift+A"] },
  trash: { scope: "gallery", chords: ["Delete", "Backspace", "Mod+Backspace"] },
  confirm: { scope: "dialog", chords: ["Enter"] },
  export: { scope: "global", chords: ["Mod+Shift+E"] },
  playPause: { scope: "video", chords: [" "] },
  skipBack: { scope: "video", chords: ["Shift+ArrowLeft"] },
  skipForward: { scope: "video", chords: ["Shift+ArrowRight"] },
  frameBack: { scope: "video", chords: [","] },
  frameForward: { scope: "video", chords: ["."] },
  undoLocation: { scope: "map", chords: ["Mod+Z"] },
  regionOut: { scope: "map", chords: ["-", "_"] },
  regionReset: { scope: "map", chords: ["+", "="] },
  rateClearNext: { scope: "photo", chords: ["Shift+Digit0"] },
  rate1Next: { scope: "photo", chords: ["Shift+Digit1"] },
  rate2Next: { scope: "photo", chords: ["Shift+Digit2"] },
  rate3Next: { scope: "photo", chords: ["Shift+Digit3"] },
  rate4Next: { scope: "photo", chords: ["Shift+Digit4"] },
  rate5Next: { scope: "photo", chords: ["Shift+Digit5"] },
  toggleSidebar: { scope: "global", chords: ["Mod+Alt+S"], mac: ["Ctrl+Mod+S"] },
  // Sidebar order (lib/mainPages.ts); menu.rs binds these.
  page1: { scope: "global", chords: ["Mod+Digit1"], desktopOnly: true },
  page2: { scope: "global", chords: ["Mod+Digit2"], desktopOnly: true },
  page3: { scope: "global", chords: ["Mod+Digit3"], desktopOnly: true },
  page4: { scope: "global", chords: ["Mod+Digit4"], desktopOnly: true },
  page5: { scope: "global", chords: ["Mod+Digit5"], desktopOnly: true },
  // The identification review queue (ReviewPage).
  reviewConfirm: { scope: "review", chords: ["Enter"] },
  reviewPick: { scope: "review", chords: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"] },
  reviewNotSure: { scope: "review", chords: ["S"] },
  reviewNext: { scope: "review", chords: ["ArrowDown"] },
  reviewPrevious: { scope: "review", chords: ["ArrowUp"] },
  // Photo versions (components/PhotoVersions.tsx, VersionSuggestions.tsx), on Lightroom's stack
  // keys: Mod+G groups (links), Mod+Shift+G unstacks (splits out, keeps apart). The two bare
  // Shift chords are Shift+A (alternates, the Versions panel) and Shift+U (use as the photo);
  // Shift+G and Shift+S belong to the companion app, so they stay free here.
  versionsShow: { scope: "photo", chords: ["Shift+A"] },
  // Left and Right page photos, and [ ] are the encounter keys the culling app shares.
  versionPrevious: { scope: "photo", chords: ["Alt+ArrowLeft"] },
  versionNext: { scope: "photo", chords: ["Alt+ArrowRight"] },
  versionUseAsPhoto: { scope: "photo", chords: ["Shift+U"] },
  versionSplitOut: { scope: "photo", chords: ["Mod+Shift+G"] },
  versionLinkTo: { scope: "photo", chords: ["Mod+G"] },
  versionReviewLinkAll: { scope: "import", chords: ["Mod+Enter"] },
  versionReviewLink: { scope: "import", chords: ["Mod+G"] },
  versionReviewDismiss: { scope: "import", chords: ["Mod+Shift+G"] },
  // Import compare mode (importReview/ImportCompareView.tsx); inside it Left and Right page the
  // species' photos, Up and Down move between your photos, Z toggles Fit and Subject.
  compareImport: { scope: "import", chords: ["C"] },
  compareSpecies: { scope: "import", chords: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"] },
  // Import review: Up and Down only move between photos; these take back or clear a species.
  importUndo: { scope: "import", chords: ["Mod+Z"] },
  importClear: { scope: "import", chords: ["Backspace"] },
  // Not S: in compare a letter starts the species search.
  importNoAnimal: { scope: "import", chords: ["Mod+Backspace"] },
  listNext: { scope: "widget", chords: ["ArrowDown"] },
  listPrevious: { scope: "widget", chords: ["ArrowUp"] },
  listFirst: { scope: "widget", chords: ["Home"] },
  listLast: { scope: "widget", chords: ["End"] },
  stepUp: { scope: "widget", chords: ["ArrowRight"] },
  stepDown: { scope: "widget", chords: ["ArrowLeft"] },
  choose: { scope: "widget", chords: ["Enter"] },
  toggle: { scope: "widget", chords: [" "] },
  focusCycle: { scope: "widget", chords: ["Tab", "Shift+Tab"] },
};

/** Lightroom keys Lifer has no action for yet; nothing else may take them
 *  (docs/plans/keyboard-shortcuts.md, "Reserved keys"). */
export const RESERVED_CHORDS: readonly string[] = [
  "N",
  "O",
  "L",
  "Shift+Z",
  "Shift+X",
  "Shift+C",
  "BracketLeft",
  "BracketRight",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
  "CapsLock",
  "T",
  "D",
  "R",
  "Y",
  "V",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "P",
  "X",
  "U",
  "B",
  "Mod+BracketLeft",
  "Mod+BracketRight",
  "Mod+E",
  "Mod+Alt+F",
  "H",
  "Shift+G",
  "Shift+S",
];

/** The parts of a DOM or React keyboard event the registry reads. */
export type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

const isCodeToken = (k: string) => /^(Digit\d|Numpad\d|Bracket(Left|Right))$/.test(k);

/** True when the event is this chord. Shift is ignored for symbol keys ("?", "+"), whose
 *  printed character already encodes it. */
export function matchesChord(e: KeyLike, chord: string, mac = isMac): boolean {
  const parts = chord.split("+");
  // A trailing "+" is the plus key itself ("+", "Mod++").
  const key = chord.endsWith("++") || chord === "+" ? "+" : parts[parts.length - 1]!;
  const mods = new Set(chord === "+" ? [] : parts.slice(0, key === "+" ? -2 : -1));
  const ctrl = mods.has("Ctrl") || (!mac && mods.has("Mod"));
  const meta = mac && mods.has("Mod");
  if (e.ctrlKey !== ctrl || e.metaKey !== meta || e.altKey !== mods.has("Alt")) return false;
  const symbol = !/^[a-z0-9]$/i.test(key) && !isCodeToken(key) && key.length === 1;
  if (!symbol && e.shiftKey !== mods.has("Shift")) return false;
  if (isCodeToken(key)) {
    // Numpad digits count as the same digit.
    return e.code === key || e.code === key.replace("Digit", "Numpad");
  }
  return key.length === 1 ? e.key.toLowerCase() === key.toLowerCase() : e.key === key;
}

/** Whether the event triggers `action`. */
export function matches(e: KeyLike, action: KeyAction, mac = isMac): boolean {
  const entry = KEYMAP[action];
  return (mac && entry.mac ? entry.mac : entry.chords).some((c) => matchesChord(e, c, mac));
}

/** The first action in `actions` the event triggers, or undefined. */
export function matchAction<A extends KeyAction>(e: KeyLike, actions: readonly A[]): A | undefined {
  return actions.find((a) => matches(e, a));
}

const NAMES: Record<string, string> = {
  ArrowRight: "→",
  ArrowLeft: "←",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  " ": "Space",
  Enter: "Enter",
  Backspace: "Backspace",
  Delete: "Delete",
  Tab: "Tab",
  Home: "Home",
  End: "End",
};

/** Display label for one chord, e.g. "⌘⇧I" on macOS and "Ctrl+Shift+I" elsewhere. */
export function chordLabel(chord: string, mac = isMac): string {
  const key = chord.endsWith("++") || chord === "+" ? "+" : chord.split("+").pop()!;
  const mods = chord === "+" ? [] : chord.split("+").slice(0, key === "+" ? -2 : -1);
  const shown = isCodeToken(key) ? key.replace(/^(Digit|Numpad)/, "") : (NAMES[key] ?? key.toUpperCase());
  if (mac) {
    return (
      (mods.includes("Ctrl") ? "⌃" : "") +
      (mods.includes("Alt") ? "⌥" : "") +
      (mods.includes("Shift") ? "⇧" : "") +
      (mods.includes("Mod") ? "⌘" : "") +
      shown
    );
  }
  return [...new Set(mods.map((m) => (m === "Mod" ? "Ctrl" : m))), shown].join("+");
}

/** Labels for every chord of an action, for tooltips and the shortcut sheet. */
export function shortcutLabels(action: KeyAction, mac = isMac): string[] {
  const entry = KEYMAP[action];
  return (mac && entry.mac ? entry.mac : entry.chords).map((c) => chordLabel(c, mac));
}

export const shortcutLabel = (action: KeyAction, mac = isMac) => shortcutLabels(action, mac)[0]!;
