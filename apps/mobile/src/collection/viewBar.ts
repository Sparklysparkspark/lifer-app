// The two bar controls the Collection and the Gallery share, as the desktop's: a View menu for how the
// list looks, and a Filters button for what it shows, with the number of filters on as its badge.
import type { BarItem, MenuEntry } from "../navigation/useHeader";

type T = (key: string, opts?: Record<string, unknown>) => string;

export const viewAndFilters = (t: T, view: MenuEntry[], filtersOn: number, openFilters: () => void): BarItem[] => [
  { type: "menu", key: "view", label: t("collection.view"), icon: "view", items: view },
  {
    type: "button",
    key: "filters",
    label: filtersOn ? t("collection.filtersOn", { n: filtersOn }) : t("collection.filters"),
    icon: "filter",
    badge: filtersOn ? String(filtersOn) : undefined,
    onPress: openFilters,
  },
];

/** Checkmarked choices for a View submenu. */
export const choices = <V>(values: V[], current: V, label: (v: V) => string, set: (v: V) => void): MenuEntry[] =>
  values.map((v) => ({ type: "action", label: label(v), checked: v === current, onPress: () => set(v) }));

/** An on and off View option, shown with a checkmark when on. */
export const toggle = (label: string, on: boolean, set: (on: boolean) => void): MenuEntry => ({
  type: "action",
  label,
  checked: on,
  onPress: () => set(!on),
});
