// Tree of life (V-16): class, order, family and genus down to species, from
// GET /api/collection/tree?include=uncollected, whose collected totals equal Collection's (U1).
// The tree on the left as a list or a circle, the selected group or species on the right (a sheet
// on a phone). The list is windowed over the expanded rows, so 10,000 species scroll like 100, and
// its expansion, focus, selection and scroll survive opening a photo, a species page and coming back.
// The region and the focused group live in the URL, each change its own history entry, so Back and
// the swipe step out one layer at a time.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { apiPath } from "../api/client";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import FilterPopover from "../components/FilterPopover";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import Modal from "../components/Modal";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import ProgressiveImg from "../components/ProgressiveImg";
import PageHeader from "../components/PageHeader";
import SearchInput from "../components/SearchInput";
import SegmentedControl from "../components/SegmentedControl";
import SpeciesNameText from "../components/SpeciesNameText";
import Switch from "../components/Switch";
import Chevron from "../components/Chevron";
import AreaPills from "../components/AreaPills";
import { Tooltip } from "../components/Tooltip";
import { useWindowRange } from "../components/windowing";
import { LoadingScreen } from "../components/LoadingScreen";
import { taxonDisplayLabel } from "@lifer/shared";
import { downloadWithToast } from "../lib/downloadFile";
import { formatNumber } from "../lib/format";
import { useApiResource } from "../lib/resource";
import { speciesGroupLabel, taxonClassLabel } from "../lib/speciesGroups";
import { namePartClass, useSpeciesNameParts } from "../lib/speciesName";
import { useToast } from "../hooks/useToast";
import { usePersistedState } from "../hooks/usePersistedState";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { useSearchParamsKeepingState } from "../hooks/useSearchParamsKeepingState";
import { useRegionsWithPhotos } from "../hooks/useRegionsWithPhotos";
import { useRegionTree } from "./collection/useRegionTree";
import { usePersistedFlag } from "./collection/useCollectionDisplayPrefs";
import { matches } from "../lib/keymap";
import ExplorerDetail from "./explorer/ExplorerDetail";
import TreeCircle from "./explorer/TreeCircle";
import {
  ancestorIds,
  collectedLeaves,
  explorerMemory as memory,
  indexTree,
  myBranches,
  searchTree,
  visibleRows,
  type TreeNode,
  type VisibleRow,
} from "./explorer/treeModel";

const GROUP_ROW = 84;
// Species names can run to three lines on a phone (very long Latin names).
const SPECIES_ROW = 76;
const INDENT = 24;
const MOUNT = { above: 2, below: 2 };
const WIDE = "(min-width: 1024px)";
const RESULTS = 50;
const TREE_TIMEOUT_MS = 30_000;
const RANK_KEYS: Record<TreeNode["rank"], string> = {
  class: "explorer.rank.class",
  order: "explorer.rank.order",
  family: "explorer.rank.family",
  genus: "explorer.rank.genus",
  species: "explorer.rank.species",
};

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia?.(WIDE);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
const isWide = () => window.matchMedia?.(WIDE).matches ?? true;

// An uncollected species or group shows its catalog reference photo instead of one of yours.
const slideFor = (node: TreeNode, caption: string): LightboxSlide => ({
  url: node.photoId ? `/api/photos/${node.photoId}/display` : (node.referenceUrl ?? ""),
  thumbUrl: node.photoId ? `/api/photos/${node.photoId}/thumb` : node.referenceUrl,
  caption,
  speciesId: node.speciesId ?? null,
});

/** Connector lines: one vertical per indent level that runs on, and an elbow into this row. */
function RowLines({ lines }: { lines: boolean[] }) {
  return lines.map((more, level) => {
    const own = level === lines.length - 1;
    if (!own && !more) return null;
    // Relative to the row, which starts at its own indent.
    const x = (level - lines.length) * INDENT + 12;
    return (
      <span key={level} aria-hidden="true">
        <span className="absolute w-px bg-line" style={{ left: x, top: 0, bottom: own && !more ? "50%" : 0 }} />
        {own && <span className="absolute h-px bg-line" style={{ left: x, top: "50%", width: INDENT - 4 }} />}
      </span>
    );
  });
}

export default function TaxaExplorer() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const nameParts = useSpeciesNameParts();
  const [params, setParams] = useSearchParamsKeepingState();
  const { state } = useLocation();
  // Collection's param, so a region link means the same on both pages.
  const urlRegion = params.get("region");
  const regions = useRegionTree(urlRegion);
  // World is every region, so it is the unfiltered tree rather than a scan of the whole catalogue.
  const regionId = urlRegion === regions.worldRegion?.id ? null : urlRegion;
  const regionsWithPhotos = useRegionsWithPhotos();
  // A region waits for the region list, so a World link is never fetched as a filter.
  const treePath =
    regionId && !regions.regionsLoaded ? null : apiPath("/collection/tree", {}, { include: "uncollected", regionId });
  const res = useApiResource<{ collected: number; tree: TreeNode[] }>(treePath);
  // The last tree stays up while another region's loads, so the page never drops to a spinner.
  const [lastTree, setLastTree] = useState(res.data);
  if (res.data && res.data !== lastTree) setLastTree(res.data);
  const tree = res.data ?? lastTree;
  // A tree that hasn't answered in 30s shows as failed with Retry; a late answer still replaces it.
  const [timedOut, setTimedOut] = useState<string | null>(null);
  if (timedOut && timedOut !== treePath) setTimedOut(null);
  const waiting = !!treePath && !res.data && !res.error;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setTimedOut(treePath), TREE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting, treePath]);
  const failed = !res.data && (!!res.error || (!!treePath && timedOut === treePath));
  const retry = () => {
    setTimedOut(null);
    void res.reload();
  };
  const loading = !res.data && !failed && !!tree;
  const index = useMemo(() => (tree ? indexTree(tree.tree) : null), [tree]);
  useScrollMemory(!!index);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const [view, setView] = usePersistedState<"list" | "circle">("explorer.view", "list");
  // Most genera hold one species, so the simple shape skips them.
  const [genus, setGenus] = usePersistedState("explorer.genus", false);
  // Same key as the Collection View menu, so the choice is shared.
  const [uncollectedColour, setUncollectedColour] = usePersistedFlag("uncollectedColour");

  // Bird families have birding names ("Owls"); which list applies depends on the family's class.
  const familyClass = useMemo(() => {
    const out = new Map<TreeNode, string>();
    for (const [id, entry] of index?.byId ?? [])
      if (entry.node.rank === "family") out.set(entry.node, id.slice("class:".length, id.indexOf("/")));
    return out;
  }, [index]);
  const label = useCallback(
    (node: TreeNode) =>
      node.rank === "species"
        ? nameParts({ commonName: node.commonName, scientificName: node.name }).primary.text
        : node.name === "Other"
          ? t("taxa.other")
          : node.rank === "class"
            ? (taxonClassLabel(node.name) ?? taxonDisplayLabel(node.name, []))
            : node.rank === "family"
              ? speciesGroupLabel(familyClass.get(node) ?? null, node.name)
              : node.name,
    [nameParts, familyClass, t],
  );

  // The name under or beside the main one: a species' other names, a group's Latin name.
  const secondName = (node: TreeNode) =>
    node.rank === "species"
      ? nameParts({ commonName: node.commonName, scientificName: node.name }).secondary
      : node.rank !== "class" && node.name !== "Other" && label(node) !== node.name
        ? [{ kind: "scientific" as const, text: node.name }]
        : [];
  const nameClass = (node: TreeNode) =>
    node.rank === "species"
      ? namePartClass(nameParts({ commonName: node.commonName, scientificName: node.name }).primary)
      : node.rank === "genus"
        ? "italic"
        : "";

  const [expandedState, setExpanded] = useState<Set<string> | null>(memory.expanded);
  // Until the tree is opened or closed by hand, it opens on your photographed branches.
  const expanded = useMemo(
    () => expandedState ?? (index ? myBranches(index) : new Set<string>()),
    [expandedState, index],
  );
  const [selected, select] = useState<string | null>(memory.selected);
  const focusState = params.get("focus");
  useEffect(() => {
    memory.expanded = expandedState;
    memory.selected = selected;
  }, [expandedState, selected]);
  // A new history entry per layer or region; backSteps lets the header's Back skip them all.
  const go = (updates: Record<string, string | null>) => {
    if (Object.entries(updates).every(([k, v]) => params.get(k) === v)) return;
    const steps = (state as { backSteps?: number } | null)?.backSteps ?? 1;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v) next.set(k, v);
          else next.delete(k);
        }
        return next;
      },
      { state: { ...(state as object | null), backSteps: steps + 1 } },
    );
  };
  // A focus on a genus while genera are hidden falls back to its family.
  const focusEntry = focusState ? index?.byId.get(focusState) : undefined;
  const focus = focusEntry ? (!genus && focusEntry.node.rank === "genus" ? focusEntry.parentId : focusState) : null;

  const [active, setActive] = useState<string | null>(memory.selected);
  const [query, setQuery] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [option, setOption] = useState(0);
  const listId = useId();
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);

  const rows = useMemo(
    () => (index ? visibleRows(index, expanded, { focus, genus }) : []),
    [index, expanded, focus, genus],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => {
    const heights = rows.map((r) => (r.node.rank === "species" ? SPECIES_ROW : GROUP_ROW));
    const tops: number[] = [];
    for (let i = 0, at = 0; i < heights.length; at += heights[i++]) tops.push(at);
    return { structure: rows, tops, heights };
  }, [rows]);
  const range = useWindowRange(listRef, view === "list" ? layout : null, MOUNT);

  // Scrolls a row into view and, after a keyboard move, focuses it once it is mounted.
  const [pending, setPending] = useState<{ id: string; focus: boolean } | null>(null);
  useEffect(() => {
    if (!pending || !listRef.current) return;
    const i = rows.findIndex((r) => r.id === pending.id);
    if (i < 0) return;
    const top = listRef.current.getBoundingClientRect().top + layout.tops[i];
    if (top < GROUP_ROW || top > window.innerHeight - 2 * GROUP_ROW) window.scrollBy(0, top - window.innerHeight / 3);
    const el = [...listRef.current.querySelectorAll<HTMLElement>("[role=treeitem]")].find(
      (item) => item.dataset.id === pending.id,
    );
    if (!el) return; // the next range update mounts it and runs this again
    if (pending.focus) el.focus({ preventScroll: true });
    setPending(null);
  }, [pending, rows, range, layout]);

  if (failed && !tree)
    return (
      <main className="space-y-section p-page">
        <EmptyState title={t("explorer.loadFailed")} action={{ label: t("common.retry"), onClick: retry }} />
      </main>
    );
  if (!tree || !index) return <LoadingScreen showBackLink={false} />;

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setExpanded(next);
  };
  // Opens every group above a row, closing nothing; leaves a focus the row is outside of.
  const reveal = (id: string, focusRow = false) => {
    const above = ancestorIds(index, id);
    if (focus && !above.includes(focus)) go({ focus: null });
    const next = new Set(expanded);
    for (const a of above) next.add(a);
    if (next.size !== expanded.size) setExpanded(next);
    setActive(id);
    setPending({ id, focus: focusRow });
  };
  const choose = (id: string) => {
    reveal(id);
    select(id);
  };
  const rowPhotos = rows.filter((r) => r.node.photoId);
  const openRowPhoto = (row: VisibleRow) => {
    const at = rowPhotos.indexOf(row);
    if (at < 0) return;
    setLightbox({ index: at, slides: rowPhotos.map((r) => slideFor(r.node, label(r.node))) });
  };
  const randomUnder = (id: string | null) => {
    const scope = id && index.byId.get(id)?.node.rank === "species" ? index.byId.get(id)!.parentId : id;
    const pool = scope ? collectedLeaves(index, scope) : index.roots.flatMap((r) => collectedLeaves(index, r));
    const others = pool.filter((l) => l.id !== id);
    if (others.length === 0) return null;
    return () => choose(others[Math.floor(Math.random() * others.length)].id);
  };
  const shownPath = (id: string) =>
    ancestorIds(index, id).filter((a) => genus || index.byId.get(a)!.node.rank !== "genus");
  const zoomTo = (id: string | null) => {
    go({ focus: id });
    window.scrollTo(0, 0);
  };
  const zoomOut = focus ? () => zoomTo(shownPath(focus).at(-1) ?? null) : null;

  const found = searchTree(index, query, label).filter((id) => genus || index.byId.get(id)!.node.rank !== "genus");
  const results = found.slice(0, RESULTS);
  const showResults = listOpen && query.trim().length >= 2;
  const pick = (id: string) => {
    setListOpen(false);
    if (view === "circle") {
      // A group becomes the middle; a species shows in its group.
      zoomTo(index.byId.get(id)!.node.rank === "species" ? (shownPath(id).at(-1) ?? null) : id);
      select(id);
    } else choose(id);
  };
  const onSearchKey = (e: React.KeyboardEvent) => {
    if (matches(e, "listNext")) {
      setListOpen(true);
      if (results.length) setOption((option + 1) % results.length);
    } else if (matches(e, "listPrevious")) {
      if (results.length) setOption((option - 1 + results.length) % results.length);
    } else if (matches(e, "choose") && showResults && results[option]) pick(results[option]);
    else if (matches(e, "close") && showResults) {
      // Closes just the results, not anything around the page.
      e.stopPropagation();
      setListOpen(false);
    } else return;
    e.preventDefault();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The focused row leads; the remembered one stands in when focus is elsewhere in the tree.
    const current = (e.target as HTMLElement).closest<HTMLElement>("[role=treeitem]")?.dataset.id ?? active;
    const i = rows.findIndex((r) => r.id === current);
    const row = rows[i];
    const move = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target) {
        setActive(target.id);
        setPending({ id: target.id, focus: true });
      }
    };
    const isClade = row && row.childIds.length > 0;
    if (matches(e, "listNext")) move(i + 1);
    else if (matches(e, "listPrevious")) move(i - 1);
    else if (matches(e, "listFirst")) move(0);
    else if (matches(e, "listLast")) move(rows.length - 1);
    else if (matches(e, "stepUp")) {
      if (!isClade) return;
      if (!expanded.has(row.id)) toggle(row.id);
      else move(i + 1);
    } else if (matches(e, "stepDown")) {
      if (!row) return;
      const parent = rows.findIndex((r) => r.id === row.parentId);
      if (isClade && expanded.has(row.id)) toggle(row.id);
      else if (parent >= 0) move(parent);
    } else if (matches(e, "choose")) {
      if (row) select(row.id);
    } else if (matches(e, "toggle")) {
      if (row) openRowPhoto(row);
    } else return;
    e.preventDefault();
  };

  const exportCsv = () =>
    void downloadWithToast(
      toast,
      `/api${apiPath("/collection/tree", {}, { format: "csv", regionId })}`,
      "lifer-collection.csv",
    );
  const selectedEntry = selected ? index.byId.get(selected) : undefined;
  const detail = selected && selectedEntry && (
    <ExplorerDetail
      index={index}
      id={selected}
      label={label}
      onSelect={choose}
      onRandom={randomUnder(selected)}
      onFocusGroup={
        selectedEntry.node.rank !== "species" && selected !== focus && (genus || selectedEntry.node.rank !== "genus")
          ? () => {
              zoomTo(selected);
              if (!wide) select(null);
            }
          : null
      }
      onOpenPhotos={(nodes, start) => setLightbox({ index: start, slides: nodes.map((n) => slideFor(n, label(n))) })}
    />
  );
  const first = range?.[0] ?? 0;
  const last = Math.min(range?.[1] ?? 40, rows.length - 1);
  const focusable = active && rows.some((r) => r.id === active) ? active : rows[0]?.id;
  const random = randomUnder(null);
  const optionId = (i: number) => `${listId}-${i}`;

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        title={t("explorer.title")}
        backFallbackTo="/stats"
        backLabel={t("nav.stats")}
        actions={
          tree.collected > 0 ? (
            <Button variant="secondary" size="sm" onClick={exportCsv}>
              {t("explorer.export")}
            </Button>
          ) : undefined
        }
      />
      <main className="space-y-section p-page">
        {tree.collected === 0 && !regionId ? (
          <EmptyState
            title={t("explorer.emptyTitle")}
            action={{ label: t("nav.importPhotos"), onClick: () => navigate("/import") }}
          />
        ) : (
          <div
            className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8"
            data-uncollected-colour={uncollectedColour || undefined}
          >
            <div className={`min-w-0 transition-opacity ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <nav
                  aria-label={t("explorer.regionPath")}
                  className="flex flex-wrap items-center gap-1 text-callout text-muted"
                >
                  {regionId ? (
                    <Button variant="link" size="sm" onClick={() => go({ region: null })}>
                      {t("explorer.allRegions")}
                    </Button>
                  ) : (
                    <span aria-current="location" className="font-semibold text-ink">
                      {t("explorer.allRegions")}
                    </span>
                  )}
                  {regionId &&
                    regions.breadcrumb
                      .filter((r) => r.id !== regions.worldRegion?.id)
                      .map((r, i, trail) => (
                        <span key={r.id} className="flex min-w-0 items-center gap-1">
                          <span aria-hidden="true">›</span>
                          {i === trail.length - 1 ? (
                            <span aria-current="location" className="font-semibold text-ink wrap-anywhere">
                              {r.name}
                            </span>
                          ) : (
                            <Button variant="link" size="sm" onClick={() => go({ region: r.id })}>
                              {r.name}
                            </Button>
                          )}
                        </span>
                      ))}
                </nav>
                {(regionId ? regions.children : regions.downloadedCountries).length > 0 && (
                  // Wraps under the trail rather than squeezing beside it.
                  <div className="min-w-64 flex-1">
                    <AreaPills
                      areas={regionId ? regions.children : regions.downloadedCountries}
                      withPhotos={regionsWithPhotos}
                      onPick={(id) => go({ region: id })}
                    />
                  </div>
                )}
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-72">
                  <SearchInput
                    value={query}
                    onChange={(q) => {
                      setQuery(q);
                      setOption(0);
                      setListOpen(true);
                    }}
                    onFocus={() => setListOpen(true)}
                    onBlur={() => setListOpen(false)}
                    onKeyDown={onSearchKey}
                    placeholder={t("explorer.searchPlaceholder")}
                    aria-label={t("explorer.searchPlaceholder")}
                    inputProps={{
                      role: "combobox",
                      autoComplete: "off",
                      "aria-autocomplete": "list",
                      "aria-expanded": showResults,
                      "aria-controls": listId,
                      "aria-activedescendant": showResults && results.length ? optionId(option) : undefined,
                    }}
                  />
                  {showResults && (
                    <ul
                      id={listId}
                      role="listbox"
                      aria-label={t("explorer.results")}
                      className="absolute inset-x-0 top-full z-30 mt-1 max-h-96 min-w-72 overflow-y-auto rounded-panel border border-line bg-surface py-1 shadow-lg"
                    >
                      {results.length === 0 && (
                        <li className="px-3 py-2 text-callout text-muted">{t("explorer.noMatch")}</li>
                      )}
                      {results.map((id, i) => {
                        const { node } = index.byId.get(id)!;
                        const path = shownPath(id).map((a) => label(index.byId.get(a)!.node));
                        const rank = t(RANK_KEYS[node.rank]);
                        return (
                          <li
                            key={id}
                            id={optionId(i)}
                            role="option"
                            aria-selected={i === option}
                            // Keeps focus in the field, so its blur doesn't close the list before the pick.
                            onMouseDown={(e) => {
                              e.preventDefault();
                              pick(id);
                            }}
                            onMouseEnter={() => setOption(i)}
                            className={`cursor-pointer px-3 py-1.5 ${i === option ? "bg-surface-muted" : ""}`}
                          >
                            <span className="block text-callout wrap-anywhere">
                              <span className={`text-ink ${nameClass(node)}`}>{label(node)}</span>
                              {secondName(node).length > 0 && (
                                <span className="ml-1.5 text-footnote text-muted">
                                  <SpeciesNameText parts={secondName(node)} />
                                </span>
                              )}
                            </span>
                            <span className="block text-footnote text-muted wrap-anywhere">
                              {path.length ? t("explorer.resultPath", { rank, path: path.join(" / ") }) : rank}
                            </span>
                          </li>
                        );
                      })}
                      {found.length > RESULTS && (
                        <li className="px-3 py-1.5 text-footnote text-muted">
                          {t("explorer.moreResults", { count: found.length - RESULTS })}
                        </li>
                      )}
                    </ul>
                  )}
                </div>
                <SegmentedControl
                  label={t("explorer.shape")}
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "list", label: t("explorer.list") },
                    { value: "circle", label: t("explorer.circle") },
                  ]}
                />
                <FilterPopover label={t("collection.toolbar.view")} activeCount={0}>
                  <Tooltip content={{ label: t("explorer.rank.genus"), description: t("explorer.generaHelp") }}>
                    {(tip) => (
                      <label {...tip} className="flex items-center justify-between gap-4 text-callout text-ink">
                        {t("explorer.showGenera")}
                        <Switch checked={genus} onChange={setGenus} label={t("explorer.showGenera")} />
                      </label>
                    )}
                  </Tooltip>
                  <Tooltip
                    content={{
                      label: t("collection.toolbar.uncollectedColour"),
                      description: t("collection.toolbar.uncollectedColourTitle"),
                    }}
                  >
                    {(tip) => (
                      <label {...tip} className="mt-3 flex items-center justify-between gap-4 text-callout text-ink">
                        {t("collection.toolbar.uncollectedColour")}
                        <Switch
                          checked={uncollectedColour}
                          onChange={setUncollectedColour}
                          label={t("collection.toolbar.uncollectedColour")}
                        />
                      </label>
                    )}
                  </Tooltip>
                </FilterPopover>
                <div className="ml-auto flex flex-wrap gap-2">
                  {view === "list" && (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          setExpanded(
                            new Set([...expanded, ...rows.filter((r) => r.childIds.length > 0).map((r) => r.id)]),
                          )
                        }
                      >
                        {t("explorer.expandLevel")}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setExpanded(myBranches(index))}>
                        {t("explorer.myBranches")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={expanded.size === 0}
                        onClick={() => setExpanded(new Set())}
                      >
                        {t("explorer.collapseAll")}
                      </Button>
                    </>
                  )}
                  {random && (
                    <Button variant="secondary" size="sm" onClick={random}>
                      {t("explorer.random")}
                    </Button>
                  )}
                </div>
              </div>
              {focus && (
                <nav
                  aria-label={t("explorer.focusPath")}
                  className="sticky top-[var(--mac-title-bar,0px)] z-10 mb-2 flex flex-wrap items-center gap-x-1 bg-canvas py-1.5 text-footnote"
                >
                  <Button variant="link" size="sm" onClick={() => zoomTo(null)}>
                    {t("explorer.allGroups")}
                  </Button>
                  {[...shownPath(focus), focus].map((id) => (
                    <span key={id} className="flex min-w-0 items-center gap-1">
                      <span aria-hidden="true" className="text-muted">
                        /
                      </span>
                      {id === focus ? (
                        <span aria-current="location" className="font-semibold text-ink wrap-anywhere">
                          {label(index.byId.get(id)!.node)}
                        </span>
                      ) : (
                        <Button variant="link" size="sm" onClick={() => zoomTo(id)}>
                          {label(index.byId.get(id)!.node)}
                        </Button>
                      )}
                    </span>
                  ))}
                </nav>
              )}
              {failed ? (
                <EmptyState title={t("explorer.loadFailed")} action={{ label: t("common.retry"), onClick: retry }} />
              ) : tree.tree.length === 0 ? (
                <EmptyState
                  title={t("explorer.regionEmpty")}
                  action={{ label: t("explorer.allRegions"), onClick: () => go({ region: null }) }}
                />
              ) : view === "circle" ? (
                <TreeCircle
                  index={index}
                  center={focus}
                  genus={genus}
                  selected={selected}
                  label={label}
                  onZoomOut={zoomOut}
                  onPick={(id) => {
                    const entry = index.byId.get(id)!;
                    const group = entry.node.rank !== "species";
                    if (group) go({ focus: id });
                    // On a phone the detail is a sheet, so zooming into a group doesn't also open it.
                    if (!group || wide) select(id);
                  }}
                />
              ) : (
                <div
                  ref={listRef}
                  role="tree"
                  aria-label={t("explorer.title")}
                  onKeyDown={onKeyDown}
                  style={{
                    height: layout.tops.length ? layout.tops.at(-1)! + layout.heights.at(-1)! : 0,
                    position: "relative",
                  }}
                >
                  {rows.slice(first, last + 1).map((row, k) => {
                    const { node, id, depth } = row;
                    const isClade = row.childIds.length > 0;
                    const open = expanded.has(id);
                    const faded = node.collected === 0;
                    const isSpecies = node.rank === "species";
                    const name = label(node);
                    const second = secondName(node);
                    const at = first + k;
                    return (
                      <div
                        key={id}
                        data-id={id}
                        role="treeitem"
                        aria-level={depth + 1}
                        aria-expanded={isClade ? open : undefined}
                        aria-selected={selected === id}
                        tabIndex={id === focusable ? 0 : -1}
                        onFocus={() => setActive(id)}
                        onClick={() => {
                          setActive(id);
                          select(id);
                          // Opening a group by its name never closes it; the chevron does both.
                          if (isClade && !open) toggle(id);
                        }}
                        className={`absolute right-0 flex cursor-pointer items-center gap-2 rounded-control pr-2 transition-colors hover:bg-line focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                          selected === id ? "bg-accent/10" : ""
                        }`}
                        // The row starts at its own indent, so its highlight spans only its group.
                        style={{ top: layout.tops[at], height: layout.heights[at], left: depth * INDENT }}
                      >
                        <RowLines lines={row.lines} />
                        {isClade && open && (
                          // The line down to this group's own children.
                          <span
                            aria-hidden="true"
                            className="absolute bottom-0 w-px bg-line"
                            style={{ left: 12, top: "calc(50% + 10px)" }}
                          />
                        )}
                        <span
                          aria-hidden="true"
                          className={`relative flex h-8 w-6 shrink-0 items-center justify-center ${isClade ? "" : "invisible"}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isClade) toggle(id);
                          }}
                        >
                          <Chevron open={open} />
                        </span>
                        {node.photoId ? (
                          // raw-control: the whole thumbnail is the button that opens the photo.
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={t("explorer.openPhoto", { name })}
                            onClick={(e) => {
                              // The row's own click selects and expands; a photo only opens.
                              e.stopPropagation();
                              openRowPhoto(row);
                            }}
                            className="h-14 w-14 shrink-0 overflow-hidden rounded-panel transition hover:opacity-90"
                          >
                            <ProgressiveImg
                              thumbSrc={`/api/photos/${node.photoId}/thumb`}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          </button>
                        ) : node.referenceUrl ? (
                          <span
                            className={`h-14 w-14 shrink-0 overflow-hidden rounded-panel bg-surface-muted ${faded ? "cover-uncollected opacity-70" : ""}`}
                          >
                            <ProgressiveImg
                              thumbSrc={node.referenceUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          </span>
                        ) : (
                          <PhotoPlaceholder className="h-14 w-14 shrink-0 rounded-panel" />
                        )}
                        <div className={`min-w-0 flex-1 ${faded ? "opacity-70" : ""}`}>
                          {!isSpecies && (
                            <p className="text-overline text-muted uppercase">{t(RANK_KEYS[node.rank])}</p>
                          )}
                          <p
                            className={`${isSpecies ? "line-clamp-3" : "line-clamp-2"} text-callout wrap-anywhere`}
                            title={name}
                          >
                            <span className={`font-semibold text-ink ${nameClass(node)}`}>{name}</span>
                            {second.length > 0 && (
                              <span className="ml-1.5 text-footnote text-muted">
                                <SpeciesNameText parts={second} />
                              </span>
                            )}
                          </p>
                          {!isSpecies ? (
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2">
                              <span
                                className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line"
                                aria-hidden="true"
                              >
                                <span
                                  className="block h-full rounded-full bg-accent"
                                  style={{ width: `${node.total ? (node.collected / node.total) * 100 : 0}%` }}
                                />
                              </span>
                              <span className="text-footnote text-muted tabular-nums">
                                {t("explorer.speciesOf", {
                                  collected: formatNumber(node.collected),
                                  total: formatNumber(node.total),
                                })}
                              </span>
                              {node.photos > 0 && (
                                <span className="text-footnote text-muted tabular-nums">
                                  {t("explorer.photoCount", {
                                    count: node.photos,
                                    formatted: formatNumber(node.photos),
                                  })}
                                </span>
                              )}
                            </div>
                          ) : (
                            <p className="text-footnote text-muted tabular-nums">
                              {faded
                                ? t("explorer.notYet")
                                : node.photos > 0 &&
                                  t("explorer.photoCount", {
                                    count: node.photos,
                                    formatted: formatNumber(node.photos),
                                  })}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {wide ? (
              <aside className="sticky top-4 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-panel border border-line bg-surface p-4">
                {detail || <p className="text-callout text-muted">{t("explorer.detailEmpty")}</p>}
              </aside>
            ) : (
              <Modal open={!!detail} onClose={() => select(null)} ariaLabel={t("explorer.title")}>
                {detail}
              </Modal>
            )}
          </div>
        )}
        {lightbox && (
          <Lightbox
            slides={lightbox.slides}
            index={lightbox.index}
            onIndexChange={(i) => setLightbox({ ...lightbox, index: i })}
            onClose={() => setLightbox(null)}
          />
        )}
      </main>
    </div>
  );
}
