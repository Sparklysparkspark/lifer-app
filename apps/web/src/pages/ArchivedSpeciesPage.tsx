import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";
import InfoTip from "../components/InfoTip";
import { Spinner } from "../components/LoadingScreen";
import PhotoPlaceholder from "../components/PhotoPlaceholder";

const ARCHIVED_INFO_PARAGRAPHS = [
  "Archiving a species just hides it from your collection and region checklists. It doesn't delete any photos or history, and unarchiving brings it right back.",
  '"Unarchive all" only unarchives the species currently shown for that family. If you\'re searching, it won\'t touch any archived species the search is hiding.',
];

interface ArchivedItem {
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  taxonClass: string;
  family: string | null;
  referencePhoto: string | null;
  referenceThumbUrl: string | null;
  archivedAt: string;
}

interface ArchiveResponse {
  items: ArchivedItem[];
  families: Array<{ taxonClass: string; family: string; count: number }>;
}

// Management view for species archived/hidden via SpeciesCard's "Archive" action or the
// species detail page (see migration 037 / apps/api/src/archive/routes.ts) — archived species
// never show up in the normal collection/region checklists, so this is the only place to see
// them again and undo the choice, per-species or for a whole family at once.
export default function ArchivedSpeciesPage() {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [busyFamily, setBusyFamily] = useState<string | null>(null);
  // Same collapse-by-family pattern as the collection view's own GroupedSpeciesGrid — a
  // family the user's already decided to ignore doesn't need to keep taking up screen space
  // every time they visit this page.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Same in-view filter pattern as CollectionPage's own search (filters whatever's already on
  // screen, no separate dropdown/catalog lookup) — just scoped to the archived list instead.
  const [search, setSearch] = useState("");

  // A missing .catch() here previously meant any failure (network hiccup, a stale/mismatched
  // build, whatever) left this page spinning forever with setData never called — this is what
  // "the archived page just loads forever" turned out to be. Now it surfaces a real error with
  // a retry instead of a silent dead end.
  function load() {
    setLoadError(false);
    setData(null);
    api.get<ArchiveResponse>("/archive").then(setData).catch(() => setLoadError(true));
  }

  useEffect(load, []);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    if (!query) return data.items;
    return data.items.filter((i) => (i.commonName ?? "").toLowerCase().includes(query) || i.scientificName.toLowerCase().includes(query));
  }, [data, search]);

  const grouped = useMemo(() => {
    const byFamily = new Map<string, ArchivedItem[]>();
    for (const item of visibleItems) {
      const key = item.family ?? "Other";
      if (!byFamily.has(key)) byFamily.set(key, []);
      byFamily.get(key)!.push(item);
    }
    return [...byFamily.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visibleItems]);

  async function unarchiveOne(speciesId: string) {
    setBusyIds((prev) => new Set(prev).add(speciesId));
    try {
      await api.delete("/archive/bulk", { speciesIds: [speciesId] });
    } catch {
      alert("Couldn't unarchive that species — try again.");
    } finally {
      load();
    }
  }

  function toggleCollapsed(family: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  async function unarchiveFamily(family: string, speciesIds: string[]) {
    if (!confirm(`Unarchive all ${speciesIds.length} species in "${family}"?`)) return;
    setBusyFamily(family);
    try {
      await api.delete("/archive/bulk", { speciesIds });
    } catch {
      alert("Couldn't unarchive that group — try again.");
    } finally {
      setBusyFamily(null);
      load();
    }
  }

  // The header (with its own back link and the search box) renders unconditionally — same
  // pattern SpeciesDetailPage uses — so only the body swaps between loading/error/loaded, and
  // the back link never needs to come from LoadingScreen's own copy of it here.
  return (
    <div className="min-h-screen bg-canvas">
      <header className="page-header flex items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div>
          <BackToCollectionLink fallbackTo="/settings" label="Settings" className="text-sm text-muted hover:underline" />
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-xl font-semibold text-ink">Archived species</h1>
            <InfoTip paragraphs={ARCHIVED_INFO_PARAGRAPHS} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search archived…"
            className="w-48 rounded-md border border-line px-2 py-1 text-sm text-ink"
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-muted hover:text-muted" aria-label="Clear search">
              ✕
            </button>
          )}
          {data && (
            <p className="text-sm text-muted">
              {visibleItems.length !== data.items.length ? `${visibleItems.length} of ${data.items.length}` : data.items.length} archived
            </p>
          )}
        </div>
      </header>

      {loadError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <p className="text-muted">Couldn't load archived species.</p>
          <button onClick={load} className="text-sm text-ink underline">
            Retry
          </button>
        </div>
      ) : !data ? (
        <Spinner />
      ) : (
        <main className="space-y-8 p-6">
          {data.items.length === 0 ? (
            <p className="text-muted">
              Nothing archived yet — use the "Archive" button on a species card, or "Archive group" when a collection
              view is grouped by family, to keep species you don't care about completing off your to-collect count.
            </p>
          ) : visibleItems.length === 0 ? (
            <p className="text-muted">No archived species match "{search}".</p>
          ) : (
            <>
              {/* Collapsed groups move here as compact chips instead of sitting in the
                 vertical flow as empty-but-still-present sections — same pattern as the
                 collection view's own GroupedSpeciesGrid. */}
              {grouped.some(([family]) => collapsed.has(family)) && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2">
                  <span className="text-xs uppercase tracking-wide text-muted">Collapsed:</span>
                  {grouped
                    .filter(([family]) => collapsed.has(family))
                    .map(([family, items]) => (
                      <button
                        key={family}
                        onClick={() => toggleCollapsed(family)}
                        className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface-muted"
                      >
                        {family} ({items.length})
                      </button>
                    ))}
                  {collapsed.size >= 2 && (
                    <button onClick={() => setCollapsed(new Set())} className="ml-1 text-xs text-muted underline hover:text-ink">
                      Expand all
                    </button>
                  )}
                </div>
              )}
              {grouped
                .filter(([family]) => !collapsed.has(family))
                .map(([family, items]) => (
                  <section key={family}>
                    <div className="mb-3 flex items-center gap-3">
                      <button
                        onClick={() => toggleCollapsed(family)}
                        className="flex items-center gap-2 text-left text-sm font-medium text-ink"
                      >
                        <span className="text-muted">▾</span>
                        {family} <span className="font-normal text-muted">({items.length})</span>
                      </button>
                      <button
                        onClick={() => unarchiveFamily(family, items.map((i) => i.speciesId))}
                        disabled={busyFamily === family}
                        className="text-xs text-muted hover:text-ink hover:underline disabled:opacity-50"
                      >
                        {busyFamily === family ? "Unarchiving…" : "Unarchive all"}
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                      {items.map((item) => (
                        <div key={item.speciesId} className="rounded-lg border border-line bg-surface p-2">
                          <Link to={`/species/${item.speciesId}`} state={{ backLabel: "Archived species" }} className="block">
                            <div className="aspect-square overflow-hidden rounded bg-surface-muted">
                              {item.referenceThumbUrl ? (
                                <img
                                  src={item.referenceThumbUrl}
                                  alt={item.commonName ?? item.scientificName}
                                  className="h-full w-full object-cover"
                                />
                              ) : item.referencePhoto ? (
                                <img
                                  src={item.referencePhoto}
                                  alt={item.commonName ?? item.scientificName}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <PhotoPlaceholder className="h-full w-full" />
                              )}
                            </div>
                            <p className="mt-1 truncate text-xs font-medium text-ink">{item.commonName ?? item.scientificName}</p>
                            <p className="truncate text-[10px] italic text-muted">{item.scientificName}</p>
                          </Link>
                          <button
                            onClick={() => unarchiveOne(item.speciesId)}
                            disabled={busyIds.has(item.speciesId)}
                            className="mt-1 w-full rounded border border-line py-0.5 text-[10px] uppercase tracking-wide text-muted hover:bg-surface-muted disabled:opacity-50"
                          >
                            {busyIds.has(item.speciesId) ? "…" : "Unarchive"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
            </>
          )}
        </main>
      )}
    </div>
  );
}
