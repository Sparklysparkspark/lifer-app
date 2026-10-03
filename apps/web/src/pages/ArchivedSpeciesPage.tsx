import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import PageHeader from "../components/PageHeader";
import InfoTip from "../components/InfoTip";
import { Spinner } from "../components/LoadingScreen";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import SearchInput from "../components/SearchInput";
import Pill from "../components/Pill";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";

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

// Archived species never show in the collection or checklists, so this is the one place to see
// them again and unarchive, one at a time or a whole family at once.
export default function ArchivedSpeciesPage() {
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [busyFamily, setBusyFamily] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  // Archiving isn't region-scoped, so family is the natural drill-down.
  const [selectedFamily, setSelectedFamily] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  // A refetch after an unarchive keeps the current grid up instead of flashing a spinner.
  function load() {
    setLoadError(false);
    api.get<ArchiveResponse>("/archive").then(setData).catch(() => setLoadError(true));
  }

  useEffect(load, []);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    let items = data.items;
    if (selectedFamily) items = items.filter((i) => (i.family ?? "Other") === selectedFamily);
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (i) =>
        (i.commonName ?? "").toLowerCase().includes(query) ||
        i.scientificName.toLowerCase().includes(query) ||
        (i.family ?? "").toLowerCase().includes(query),
    );
  }, [data, search, selectedFamily]);

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
      toast.error("Couldn't unarchive that species. Try again.");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(speciesId);
        return next;
      });
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
    const ok = await confirm({ title: `Unarchive all ${speciesIds.length} species in "${family}"?`, confirmLabel: "Unarchive all" });
    if (!ok) return;
    setBusyFamily(family);
    try {
      await api.delete("/archive/bulk", { speciesIds });
    } catch {
      toast.error("Couldn't unarchive that group. Try again.");
    } finally {
      setBusyFamily(null);
      load();
    }
  }

  // The header renders in every state; only the body swaps between loading, error and loaded.
  return (
    <div className="flex-1 bg-canvas">
      <PageHeader sticky
        title="Archived species"
        backFallbackTo="/settings"
        backLabel="Settings"
        titleAddon={<InfoTip paragraphs={ARCHIVED_INFO_PARAGRAPHS} />}
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search archived…" className="w-48" />
            {data && (
              <p className="text-sm text-muted">
                {visibleItems.length !== data.items.length ? `${visibleItems.length} of ${data.items.length}` : data.items.length} archived
              </p>
            )}
          </>
        }
      />

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
        <main className="space-y-6 p-6">
          {data.families.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill size="sm" active={selectedFamily === null} onClick={() => setSelectedFamily(null)}>
                All families
              </Pill>
              {[...data.families]
                .sort((a, b) => a.family.localeCompare(b.family))
                .map((f) => (
                  <Pill
                    key={f.family}
                    size="sm"
                    active={selectedFamily === f.family}
                    onClick={() => setSelectedFamily(selectedFamily === f.family ? null : f.family)}
                  >
                    {f.family} ({f.count})
                  </Pill>
                ))}
            </div>
          )}
          {data.items.length === 0 ? (
            <EmptyState
              icon={
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
                  <path d="M4.5 9v9A1.5 1.5 0 0 0 6 19.5h12A1.5 1.5 0 0 0 19.5 18V9" />
                  <path d="M10 13h4" />
                </svg>
              }
              title="Nothing archived yet"
              description={`Use the "Archive" button on a species card, or "Archive group" when a collection view is grouped by family, to keep species you don't care about completing off your to-collect count.`}
            />
          ) : visibleItems.length === 0 ? (
            <p className="text-muted">No archived species match "{search}".</p>
          ) : (
            <>
              {/* Collapsed families become chips, as in the collection grid. */}
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
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              ) : item.referencePhoto ? (
                                <img
                                  src={item.referencePhoto}
                                  alt={item.commonName ?? item.scientificName}
                                  loading="lazy"
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
