// Tree of life (V-16): class, order, family and genus down to species, from
// GET /api/collection/tree?include=uncollected, whose collected totals equal Collection's (U1).
// The tree on the left, the selected group or species on the right (a sheet on a phone). The tree
// is one windowed list of the expanded rows, so 10,000 species scroll like 100, and its expansion,
// selection and scroll survive opening a photo, a species page and coming back.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { apiPath } from "../api/client";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import Lightbox, { type LightboxSlide } from "../components/Lightbox";
import Modal from "../components/Modal";
import ProgressiveImg from "../components/ProgressiveImg";
import PageHeader from "../components/PageHeader";
import SearchInput from "../components/SearchInput";
import Chevron from "../components/Chevron";
import { useWindowRange } from "../components/windowing";
import { LoadingScreen } from "../components/LoadingScreen";
import { downloadWithToast } from "../lib/downloadFile";
import { formatNumber } from "../lib/format";
import { useApiResource } from "../lib/resource";
import { taxonClassLabel } from "../lib/speciesGroups";
import { useSpeciesName } from "../lib/speciesName";
import { useToast } from "../hooks/useToast";
import { useScrollMemory } from "../hooks/useScrollMemory";
import { matches } from "../lib/keymap";
import ExplorerDetail from "./explorer/ExplorerDetail";
import {
  ancestorIds,
  collectedLeaves,
  explorerMemory as memory,
  indexTree,
  searchTree,
  visibleRows,
  type IndexedNode,
  type TreeNode,
} from "./explorer/treeModel";

const ROW = 64;
const MOUNT = { above: 2, below: 2 };
const WIDE = "(min-width: 1024px)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia?.(WIDE);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}
const isWide = () => window.matchMedia?.(WIDE).matches ?? true;

// An uncollected species shows its catalog reference photo instead of one of yours.
const slideFor = (node: TreeNode, caption: string): LightboxSlide => ({
  url: node.photoId ? `/api/photos/${node.photoId}/display` : (node.referenceUrl ?? ""),
  thumbUrl: node.photoId ? `/api/photos/${node.photoId}/thumb` : node.referenceUrl,
  caption,
  speciesId: node.speciesId ?? null,
});

export default function TaxaExplorer() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const speciesName = useSpeciesName();
  const res = useApiResource<{ collected: number; tree: TreeNode[] }>(
    apiPath("/collection/tree", {}, { include: "uncollected" }),
  );
  const tree = res.data;
  const index = useMemo(() => (tree ? indexTree(tree.tree) : null), [tree]);
  useScrollMemory(!!index);
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);

  const label = useCallback(
    (node: TreeNode) =>
      node.rank === "species"
        ? speciesName({ commonName: node.commonName, scientificName: node.name })
        : node.rank === "class"
          ? (taxonClassLabel(node.name) ?? node.name)
          : node.name,
    [speciesName],
  );

  const [expanded, setExpanded] = useState<Set<string>>(memory.expanded);
  const [selected, select] = useState<string | null>(memory.selected);
  useEffect(() => {
    memory.expanded = expanded;
    memory.selected = selected;
  }, [expanded, selected]);
  const [active, setActive] = useState<string | null>(memory.selected);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [matchAt, setMatchAt] = useState(0);
  const [lightbox, setLightbox] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);

  const rows = useMemo(() => (index ? visibleRows(index, expanded) : []), [index, expanded]);
  const listRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(
    () => ({ structure: rows, tops: rows.map((_, i) => i * ROW), heights: rows.map(() => ROW) }),
    [rows],
  );
  const range = useWindowRange(listRef, layout, MOUNT);

  // Scrolls a row into view and, after a keyboard move, focuses it once it is mounted.
  const [pending, setPending] = useState<{ id: string; focus: boolean } | null>(null);
  useEffect(() => {
    if (!pending || !listRef.current) return;
    const i = rows.findIndex((r) => r.id === pending.id);
    if (i < 0) return;
    const top = listRef.current.getBoundingClientRect().top + i * ROW;
    if (top < ROW || top > window.innerHeight - 2 * ROW) window.scrollBy(0, top - window.innerHeight / 3);
    const el = [...listRef.current.querySelectorAll<HTMLElement>("[role=treeitem]")].find(
      (item) => item.dataset.id === pending.id,
    );
    if (!el) return; // the next range update mounts it and runs this again
    if (pending.focus) el.focus({ preventScroll: true });
    setPending(null);
  }, [pending, rows, range]);

  if (res.error && !tree)
    return (
      <main className="space-y-section p-page">
        <EmptyState title={t("explorer.loadFailed")} action={{ label: t("common.retry"), onClick: res.reload }} />
      </main>
    );
  if (!tree || !index) return <LoadingScreen showBackLink={false} />;

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setExpanded(next);
  };
  // Opens every group above a row, closing nothing.
  const reveal = (id: string, focus = false) => {
    const next = new Set(expanded);
    for (const a of ancestorIds(index, id)) next.add(a);
    if (next.size !== expanded.size) setExpanded(next);
    setActive(id);
    setPending({ id, focus });
  };
  const choose = (id: string) => {
    reveal(id);
    select(id);
  };
  const rowPhotos = rows.filter((r) => r.node.photoId);
  const openRowPhoto = (row: IndexedNode) => {
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

  const found = searchTree(index, query, label);
  const jumpTo = (at: number) => {
    if (found.length === 0) return;
    const i = ((at % found.length) + found.length) % found.length;
    setMatchAt(i);
    setHighlight(found[i]);
    reveal(found[i]);
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
      if (isClade && expanded.has(row.id)) toggle(row.id);
      else if (row.parentId) move(rows.findIndex((r) => r.id === row.parentId));
    } else if (matches(e, "choose")) {
      if (row) select(row.id);
    } else if (matches(e, "toggle")) {
      if (row) openRowPhoto(row);
    } else return;
    e.preventDefault();
  };

  const exportCsv = () => void downloadWithToast(toast, "/api/collection/tree?format=csv", "lifer-collection.csv");
  const detail = selected && index.byId.has(selected) && (
    <ExplorerDetail
      index={index}
      id={selected}
      label={label}
      onSelect={choose}
      onRandom={randomUnder(selected)}
      onOpenPhotos={(nodes, start) => setLightbox({ index: start, slides: nodes.map((n) => slideFor(n, label(n))) })}
    />
  );
  const first = range?.[0] ?? 0;
  const last = Math.min(range?.[1] ?? 40, rows.length - 1);
  const focusable = active && rows.some((r) => r.id === active) ? active : rows[0]?.id;
  const random = randomUnder(null);

  return (
    <main className="space-y-section p-page">
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
      {tree.collected === 0 ? (
        <EmptyState
          title={t("explorer.emptyTitle")}
          action={{ label: t("nav.importPhotos"), onClick: () => navigate("/import") }}
        />
      ) : (
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-8">
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SearchInput
                value={query}
                onChange={(q) => {
                  setQuery(q);
                  setMatchAt(0);
                  const first = searchTree(index, q, label)[0];
                  setHighlight(first ?? null);
                  if (first) reveal(first);
                }}
                onKeyDown={(e) => {
                  if (!matches(e, "choose")) return;
                  e.preventDefault();
                  jumpTo(matchAt + 1);
                }}
                placeholder={t("explorer.searchPlaceholder")}
                aria-label={t("explorer.searchPlaceholder")}
                className="w-full sm:w-72"
              />
              {query.trim().length >= 2 && (
                <span className="text-footnote text-muted" aria-live="polite">
                  {found.length > 0
                    ? t("explorer.matches", { count: found.length, at: matchAt + 1 })
                    : t("explorer.noMatch")}
                </span>
              )}
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setExpanded(new Set([...expanded, ...rows.filter((r) => r.childIds.length > 0).map((r) => r.id)]))
                  }
                >
                  {t("explorer.expandLevel")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={expanded.size === 0}
                  onClick={() => setExpanded(new Set())}
                >
                  {t("explorer.collapseAll")}
                </Button>
                {random && (
                  <Button variant="secondary" size="sm" onClick={random}>
                    {t("explorer.random")}
                  </Button>
                )}
              </div>
            </div>
            <div
              ref={listRef}
              role="tree"
              aria-label={t("explorer.title")}
              onKeyDown={onKeyDown}
              style={{ height: rows.length * ROW, position: "relative" }}
            >
              {rows.slice(first, last + 1).map((row, k) => {
                const { node, id, depth } = row;
                const isClade = row.childIds.length > 0;
                const open = expanded.has(id);
                const faded = node.collected === 0;
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
                    className={`absolute inset-x-0 flex cursor-pointer items-center gap-2 rounded-control pr-2 transition-colors hover:bg-line focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                      selected === id ? "bg-accent/10" : ""
                    } ${highlight === id ? "ring-2 ring-inset ring-accent" : ""}`}
                    style={{ top: (first + k) * ROW, height: ROW, paddingLeft: depth * 20 }}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex h-8 w-6 shrink-0 items-center justify-center ${isClade ? "" : "invisible"}`}
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
                        aria-label={t("explorer.openPhoto", { name: label(node) })}
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
                    ) : (
                      <span
                        className={`h-14 w-14 shrink-0 overflow-hidden rounded-panel bg-surface-muted ${faded ? "cover-uncollected opacity-70" : ""}`}
                      >
                        {node.referenceUrl && (
                          <ProgressiveImg thumbSrc={node.referenceUrl} alt="" className="h-full w-full object-cover" />
                        )}
                      </span>
                    )}
                    <div className={`min-w-0 flex-1 ${faded ? "opacity-60" : ""}`}>
                      <p className="line-clamp-2 text-callout text-ink wrap-anywhere" title={label(node)}>
                        {label(node)}
                      </p>
                      {isClade ? (
                        <div className="mt-0.5 flex items-center gap-2">
                          <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden="true">
                            <span
                              className="block h-full rounded-full bg-accent"
                              style={{ width: `${node.total ? (node.collected / node.total) * 100 : 0}%` }}
                            />
                          </span>
                          <span className="text-footnote text-muted tabular-nums">
                            {t("explorer.progress", {
                              collected: formatNumber(node.collected),
                              total: formatNumber(node.total),
                            })}
                          </span>
                        </div>
                      ) : (
                        faded && <p className="text-footnote text-muted">{t("explorer.notYet")}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
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
  );
}
