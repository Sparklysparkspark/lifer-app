import { useEffect, useMemo, useRef } from "react";
import type { TFunction } from "i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { MenuAction } from "../../components/Menu";
import { formatDateSpan } from "../../lib/format";
import { useEscapeToClose } from "../../hooks/useEscapeToClose";
import type { GridCard } from "./CardGrid";
import type { Sort } from "./cardSelection";
import type { GroupBy } from "./viewPrefs";

/** The species open on this tab, kept in the URL (?species=) so Back returns to the species list. */
export function useSpeciesDrill() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const speciesId = params.get("species");
  function open(id: string) {
    const next = new URLSearchParams(params);
    next.set("species", id);
    setParams(next, { state: { drilledIn: true } });
  }
  function back() {
    // Opened from the list: step back through history, so the browser's Back and ours agree.
    if ((location.state as { drilledIn?: boolean } | null)?.drilledIn) return navigate(-1);
    const next = new URLSearchParams(params);
    next.delete("species");
    setParams(next, { replace: true });
  }
  return { speciesId, open, back };
}

/** Goes back to the species list once the open species has nothing left (its last one sent,
 *  ignored or finished), once per species: Back steps through history. */
export function useLeaveEmptySpecies(speciesId: string | null, empty: boolean, back: () => void) {
  const left = useRef<string | null>(null);
  useEffect(() => {
    if (!speciesId) left.current = null;
    if (!speciesId || !empty || left.current === speciesId) return;
    left.current = speciesId;
    back();
  });
}

export interface SpeciesGroup<T> {
  speciesId: string;
  name: string;
  items: T[];
}

/** Groups in the order each species first appears, so a newest-first list gives newest-first species. */
export function groupBySpecies<T>(
  items: T[],
  speciesIdOf: (item: T) => string,
  nameOf: (item: T) => string,
): SpeciesGroup<T>[] {
  const groups = new Map<string, SpeciesGroup<T>>();
  for (const item of items) {
    const id = speciesIdOf(item);
    const group = groups.get(id);
    if (group) group.items.push(item);
    else groups.set(id, { speciesId: id, name: nameOf(item), items: [item] });
  }
  return [...groups.values()];
}

export function sortGroups<T>(groups: SpeciesGroup<T>[], sort: Sort): SpeciesGroup<T>[] {
  if (sort === "oldest") return [...groups].reverse();
  if (sort === "name") return [...groups].sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "count") return [...groups].sort((a, b) => b.items.length - a.items.length);
  return groups;
}

/** A tab's two levels: species cards (grouped by species), or the sightings or observations of
 *  the open species, or of every species. `items` is the tab's filtered, sorted list. */
export function useSpeciesView<T>(
  items: T[],
  groupBy: GroupBy,
  sort: Sort,
  speciesIdOf: (item: T) => string,
  nameOf: (item: T) => string,
  /** Esc goes back to the species list only when nothing else (a window) is open. */
  paused: boolean,
) {
  const drill = useSpeciesDrill();
  const level: "species" | "items" = !drill.speciesId && groupBy === "species" ? "species" : "items";
  const scoped = useMemo(
    () => (drill.speciesId ? items.filter((i) => speciesIdOf(i) === drill.speciesId) : items),
    [items, drill.speciesId, speciesIdOf],
  );
  // The list is already in the chosen order, so species follow it; only "most first" re-sorts.
  const groups = useMemo(
    () =>
      level === "species"
        ? sortGroups(groupBySpecies(items, speciesIdOf, nameOf), sort === "count" ? "count" : "newest")
        : [],
    [level, items, sort, speciesIdOf, nameOf],
  );
  useEscapeToClose(drill.back, drill.speciesId !== null && !paused);
  return { drill, level, scoped, groups };
}

/** A species card: one photo from each of its sightings or observations, its counts and date range. */
export function speciesCard<T>(
  t: TFunction,
  group: SpeciesGroup<T>,
  opts: {
    itemsLabel: string;
    photoCount: number;
    earliest: string | null;
    latest: string | null;
    photos: Array<{ id: string; photoId: string | null }>;
    status: Array<string | null>;
    menu: MenuAction[];
  },
): GridCard {
  return {
    key: group.speciesId,
    name: group.name,
    photos: opts.photos,
    lines: [
      t("inaturalist.species.itemsAndPhotos", {
        items: opts.itemsLabel,
        photos: t("inaturalist.photoCount", { count: opts.photoCount }),
      }),
      opts.latest ? formatDateSpan(opts.earliest ?? opts.latest, opts.latest) : null,
      ...opts.status,
    ],
    menu: opts.menu,
    // Its +N opens the species, as the card does: one tile per sighting isn't all its photos.
    openLabel: t("inaturalist.species.open"),
  };
}
