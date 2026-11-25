// Lists added from iNaturalist ("spiders of Canada"): API types, plain-words errors, and one hook
// that loads the lists and polls only while one is still being added.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, apiPath, type ApiResponse } from "../api/client";
import { useToast } from "../hooks/useToast";
import { singularQuery } from "@lifer/shared";
import i18n from "../i18n";
import { errorMessage } from "./errorMessage";

export type SpeciesList = ApiResponse<"/species-lists">["lists"][number];
export type ListPreview = ApiResponse<"/species-lists/preview", "post">;
export type TaxonHit = ApiResponse<"/species-lists/search/taxa">["results"][number];
export type PlaceHit = ApiResponse<"/species-lists/search/places">["results"][number];

/** The API's batch size (LIST_SIZE_CAP): bigger lists are added this many species at a time. */
export const LIST_BATCH_SIZE = 5000;
export const SPECIES_LISTS_SETTINGS_PATH = "/settings/species";
const POLL_MS = 3000;
const CHANGED = "lifer:species-lists-changed";

/** Hand-picked groups under the Add a list box. Growth forms such as trees are left out on purpose:
 *  no clade means "tree". Ids from the plan's measured autocomplete (add-species-from-inaturalist.md);
 *  the ones without an id are resolved by the taxa search like typed words. */
export const STARTER_LISTS: ReadonlyArray<{ label: string; taxon?: { taxonId: number; name: string; rank: string } }> =
  [
    { label: "speciesLists.starters.lepidoptera", taxon: { taxonId: 47157, name: "Lepidoptera", rank: "order" } },
    { label: "speciesLists.starters.odonata", taxon: { taxonId: 47792, name: "Odonata", rank: "order" } },
    { label: "speciesLists.starters.bees", taxon: { taxonId: 630955, name: "Anthophila", rank: "epifamily" } },
    { label: "speciesLists.starters.spiders", taxon: { taxonId: 47118, name: "Araneae", rank: "order" } },
    { label: "speciesLists.starters.mushrooms", taxon: { taxonId: 50814, name: "Agaricomycetes", rank: "class" } },
    { label: "speciesLists.starters.ferns" },
    { label: "speciesLists.starters.conifers" },
  ];

/** Still being added (or waiting to be), so its progress is worth polling. */
export const isAdding = (l: SpeciesList) => l.status === "queued" || l.status === "running" || l.status === "offline";

/** Tells every mounted useSpeciesLists to reload, e.g. after a list was created. */
export const announceListsChanged = () => window.dispatchEvent(new Event(CHANGED));

/** iNaturalist and list failures in plain words, by the API's code. */
export function listErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "offline":
      return i18n.t("speciesLists.errors.offline");
    case "rate_limited":
    case "refused":
      return i18n.t("speciesLists.errors.busy");
    case "no_region":
      return i18n.t("speciesLists.errors.noRegion");
    default:
      return i18n.t("speciesLists.errors.failed");
  }
}

/** A thrown API call in plain words: the list codes above, else the shared message. */
export function listCallError(err: unknown): string {
  if (err instanceof ApiError && err.code && err.code !== "no_checklist") return listErrorMessage(err.code);
  return errorMessage(err, i18n.t("speciesLists.errors.failed"));
}

export const searchTaxa = (q: string, signal: AbortSignal) =>
  api.get(apiPath("/species-lists/search/taxa", {}, { q }), { signal }).then((r) => r.results);
export const searchPlaces = (q: string, signal: AbortSignal) =>
  api.get(apiPath("/species-lists/search/places", {}, { q }), { signal });

/** The user's lists, polled every few seconds while one is being added and the window is visible. */
export function useSpeciesLists(enabled = true) {
  const toast = useToast();
  const [lists, setLists] = useState<SpeciesList[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const previous = useRef(new Map<string, SpeciesList["status"]>());

  // setState only in the reply's callbacks, so effects can call this directly.
  const load = useCallback(
    () =>
      api
        .get("/species-lists")
        .then((res) => {
          // A list that was being added and is now done gets one toast (rule F2).
          for (const l of res.lists) {
            const was = previous.current.get(l.id);
            if (was && was !== "done" && was !== "paused" && l.status === "done")
              toast.success(i18n.t("speciesLists.toast.finished", { name: l.name, count: l.addedCount }));
          }
          previous.current = new Map(res.lists.map((l) => [l.id, l.status]));
          setLists(res.lists);
          setError(null);
        })
        .catch(setError),
    [toast],
  );

  useEffect(() => {
    if (!enabled) return;
    void load();
    const reload = () => void load();
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [enabled, load]);

  const polling = enabled && !!lists?.some(isAdding);
  useEffect(() => {
    if (!polling) return;
    const loadIfVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(loadIfVisible, POLL_MS);
    document.addEventListener("visibilitychange", loadIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", loadIfVisible);
    };
  }, [polling, load]);

  const replace = useCallback((list: SpeciesList) => {
    previous.current.set(list.id, list.status);
    setLists((prev) => prev?.map((l) => (l.id === list.id ? list : l)) ?? prev);
  }, []);
  const remove = useCallback((id: string) => setLists((prev) => prev?.filter((l) => l.id !== id) ?? prev), []);

  return { lists, error, reload: load, replace, remove };
}

const SEARCH_DEBOUNCE_MS = 300;
const SPECIES_RANKS = new Set(["species", "subspecies", "variety", "form", "hybrid"]);

export type Found<T> = { query: string; results: T[]; error?: unknown; unavailable?: string | null };

// A group (lists live above species rank) first, else iNaturalist's top hit.
export const bestTaxon = (hits: TaxonHit[]) => hits.find((h) => !SPECIES_RANKS.has(h.rank ?? "")) ?? hits[0] ?? null;

// The region the Collection shows when the phrase names no place; otherwise a Lifer region, then a
// real administrative place, ahead of parks and towns with the same name.
export function bestPlace(hits: PlaceHit[], preferRegionId: string | null): PlaceHit | null {
  return (
    (preferRegionId && hits.find((h) => h.regionId === preferRegionId)) ||
    hits.find((h) => h.regionId) ||
    hits.find((h) => h.adminLevel !== null) ||
    hits[0] ||
    null
  );
}

/** Debounced search for `query`, tagged with the query it answers so a stale reply never shows. */
export function useSearch<T>(query: string | null, run: (q: string, signal: AbortSignal) => Promise<Found<T>>) {
  const [found, setFound] = useState<Found<T> | null>(null);
  useEffect(() => {
    if (!query || query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      run(query, controller.signal)
        .then((res) => !controller.signal.aborted && setFound(res))
        .catch((error: unknown) => !controller.signal.aborted && setFound({ query, results: [], error }));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, run]);
  return found && found.query === query ? found : null;
}

export async function runTaxa(q: string, signal: AbortSignal): Promise<Found<TaxonHit>> {
  let results = await searchTaxa(q, signal);
  // Plurals are stripped only when the plain words find nothing (plan: "Common plurals").
  const single = singularQuery(q);
  if (results.length === 0 && single !== q && single.length >= 2) results = await searchTaxa(single, signal);
  return { query: q, results };
}
export async function runPlaces(q: string, signal: AbortSignal): Promise<Found<PlaceHit>> {
  const res = await searchPlaces(q, signal);
  return { query: q, results: res.results, unavailable: res.inatUnavailable };
}
