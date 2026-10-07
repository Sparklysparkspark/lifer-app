import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import PageHeader from "../components/PageHeader";
import InfoTip from "../components/InfoTip";
import { Spinner } from "../components/LoadingScreen";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import SearchInput from "../components/SearchInput";
import RegionPicker from "../components/RegionPicker";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";

const HIDDEN_INFO_PARAGRAPHS = [
  "Hiding a species from a region only removes it from that region's own checklist. Its global record, photos, and history are untouched, and any other region it's also found on still shows it normally.",
  "Hiding from a whole country also hides it from every province/state under that country.",
];

interface HiddenItem {
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  referencePhoto: string | null;
  referenceThumbUrl: string | null;
  hiddenAt: string;
  regionId: string;
  regionName: string;
  countryId: string | null;
  countryName: string | null;
  isCountry: boolean;
}

interface HiddenResponse {
  items: HiddenItem[];
}

// Species hidden with a card's "Hide from this region". Navigation is the same breadcrumb and
// one-level "Drill in" pills as RegionBrowser; the grid below always matches the current scope.
export default function HiddenSpeciesPage() {
  const [data, setData] = useState<HiddenResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState("");
  const confirm = useConfirm();
  const toast = useToast();
  // openCountryId: the country drilled into (narrows to all of it). selectedRegionId: one
  // province within it, or the country's own "Whole country" leaf.
  const [openCountryId, setOpenCountryId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  // Auto-drill into a lone country only on first load, not on every refetch after an unhide.
  const autoOpenedRef = useRef(false);

  function openCountry(id: string) {
    setOpenCountryId(id);
    setSelectedRegionId(null);
  }

  // A refetch after an unhide keeps the current grid up instead of flashing a spinner.
  function fetchHidden() {
    api
      .get<HiddenResponse>("/regions/hidden-species")
      .then((res) => {
        setData(res);
        // With species hidden under only one country, "All countries" would be a wasted click.
        if (!autoOpenedRef.current) {
          autoOpenedRef.current = true;
          const countryIds = [...new Set(res.items.map((i) => i.countryId).filter((id): id is string => !!id))];
          if (countryIds.length === 1) setOpenCountryId(countryIds[0]);
        }
      })
      .catch(() => setLoadError(true));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchHidden();
  }

  useEffect(fetchHidden, []);

  // One entry per country with something hidden under it; its provinces only show once opened.
  const countryGroups = useMemo(() => {
    if (!data) return [];
    const byId = new Map<
      string,
      {
        id: string;
        name: string;
        speciesIds: Set<string>;
        countryLevelCount: number;
        provinces: Map<string, { name: string; count: number }>;
      }
    >();
    for (const item of data.items) {
      if (!item.countryId || !item.countryName) continue;
      let g = byId.get(item.countryId);
      if (!g) {
        g = {
          id: item.countryId,
          name: item.countryName,
          speciesIds: new Set(),
          countryLevelCount: 0,
          provinces: new Map(),
        };
        byId.set(item.countryId, g);
      }
      // A country-wide hide writes a row per province too (so one province can be unhidden
      // alone), and a province's count includes those, since they really are hidden there.
      g.speciesIds.add(item.speciesId);
      if (item.isCountry) {
        g.countryLevelCount++;
      } else {
        const p = g.provinces.get(item.regionId) ?? { name: item.regionName, count: 0 };
        p.count++;
        g.provinces.set(item.regionId, p);
      }
    }
    return [...byId.values()]
      .map((g) => ({
        id: g.id,
        name: g.name,
        // Distinct species, not rows (a cascade writes one row per province).
        count: g.speciesIds.size,
        hasCountryLevel: g.countryLevelCount > 0,
        countryLevelCount: g.countryLevelCount,
        provinces: [...g.provinces.entries()]
          .map(([id, p]) => ({ id, name: p.name, count: p.count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);
  const openCountryGroup = openCountryId ? countryGroups.find((g) => g.id === openCountryId) : undefined;
  // The open country's provinces with something hidden, plus a "Whole country" leaf when the
  // country itself has direct hides.
  const openCountryProvinces = useMemo(() => {
    if (!openCountryGroup) return [];
    return [
      ...(openCountryGroup.hasCountryLevel
        ? [{ id: openCountryGroup.id, name: "Whole country", count: openCountryGroup.countryLevelCount }]
        : []),
      ...openCountryGroup.provinces,
    ];
  }, [openCountryGroup]);

  // Raw rows in scope: bulk unhide must clear every underlying region row, not just the cards.
  const scopedItems = useMemo(() => {
    if (!data) return [];
    let items = data.items;
    if (selectedRegionId) items = items.filter((i) => i.regionId === selectedRegionId);
    else if (openCountryId) items = items.filter((i) => i.countryId === openCountryId);
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (i) =>
        (i.commonName ?? "").toLowerCase().includes(query) ||
        i.scientificName.toLowerCase().includes(query) ||
        i.regionName.toLowerCase().includes(query),
    );
  }, [data, search, openCountryId, selectedRegionId]);

  // One card per species, preferring the country-level row (its Unhide knows to ask about the
  // provinces). Not needed once narrowed to one region.
  const displayedItems = useMemo(() => {
    if (selectedRegionId) return scopedItems;
    const seen = new Set<string>();
    const ordered = [...scopedItems].sort((a, b) => Number(b.isCountry) - Number(a.isCountry));
    return ordered.filter((item) => {
      if (seen.has(item.speciesId)) return false;
      seen.add(item.speciesId);
      return true;
    });
  }, [scopedItems, selectedRegionId]);

  const scopeLabel = selectedRegionId
    ? openCountryProvinces.find((p) => p.id === selectedRegionId)?.name
    : (openCountryGroup?.name ?? "all hidden species");

  async function unhideOne(item: HiddenItem) {
    setBusyIds((prev) => new Set(prev).add(item.speciesId));
    try {
      // A country-level unhide asks about the provinces under it rather than silently leaving
      // them hidden or silently unhiding them (hiding cascades; unhiding deliberately asks).
      let cascadeRegionIds: string[] = [];
      if (item.isCountry) {
        const res = await api.get<{ children: Array<{ regionId: string; regionName: string }> }>(
          `/regions/${item.regionId}/species/${item.speciesId}/hidden-children`,
        );
        if (res.children.length > 0) {
          const names = res.children.map((c) => c.regionName).join(", ");
          const alsoChildren = await confirm({
            title: `Also unhide from ${names}?`,
            message: `It's also hidden in ${res.children.length === 1 ? "this province" : "these provinces"}.`,
            confirmLabel: "Unhide everywhere",
            cancelLabel: "Only the country",
          });
          if (alsoChildren) cascadeRegionIds = res.children.map((c) => c.regionId);
        }
      }
      const query = cascadeRegionIds.length > 0 ? `?cascadeRegionIds=${cascadeRegionIds.join(",")}` : "";
      await api.delete(`/regions/${item.regionId}/species/${item.speciesId}/hide${query}`);
    } catch {
      toast.error("Couldn't unhide that species. Try again.");
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(item.speciesId);
        return next;
      });
      load();
    }
  }

  // One confirmation for the whole scope, over the raw rows so a country-wide hide also clears
  // every province row under it.
  async function unhideScope() {
    const uniqueSpeciesCount = new Set(scopedItems.map((i) => i.speciesId)).size;
    const ok = await confirm({
      title: `Unhide all ${uniqueSpeciesCount} species from "${scopeLabel}"?`,
      confirmLabel: "Unhide all",
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      await Promise.all(scopedItems.map((i) => api.delete(`/regions/${i.regionId}/species/${i.speciesId}/hide`)));
    } catch {
      toast.error("Couldn't unhide that group. Try again.");
    } finally {
      setBulkBusy(false);
      load();
    }
  }

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title="Hidden species"
        backFallbackTo="/settings"
        backLabel="Settings"
        titleAddon={<InfoTip paragraphs={HIDDEN_INFO_PARAGRAPHS} />}
        actions={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search hidden or a region…"
              className="w-56"
            />
          </>
        }
      />

      {loadError ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24">
          <p className="text-muted">Couldn't load hidden species.</p>
          <button onClick={load} className="text-sm text-ink underline">
            Retry
          </button>
        </div>
      ) : !data ? (
        <Spinner />
      ) : (
        <main className="space-y-6 p-6">
          {countryGroups.length > 0 && (
            <div className="space-y-2">
              <nav className="flex flex-wrap items-center gap-1 text-sm text-muted">
                <button
                  onClick={() => {
                    setOpenCountryId(null);
                    setSelectedRegionId(null);
                  }}
                  className="hover:underline"
                >
                  All countries
                </button>
                {openCountryGroup && (
                  <span className="flex items-center gap-1">
                    <span className="text-muted">/</span>
                    {selectedRegionId ? (
                      <button onClick={() => setSelectedRegionId(null)} className="hover:underline">
                        {openCountryGroup.name}
                      </button>
                    ) : (
                      <span className="font-medium text-ink">{openCountryGroup.name}</span>
                    )}
                  </span>
                )}
                {selectedRegionId && (
                  <span className="flex items-center gap-1">
                    <span className="text-muted">/</span>
                    <span className="font-medium text-ink">
                      {openCountryProvinces.find((p) => p.id === selectedRegionId)?.name}
                    </span>
                  </span>
                )}
              </nav>
              {!selectedRegionId && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-muted">Drill in:</span>
                  <RegionPicker
                    mode="single"
                    items={
                      openCountryId
                        ? openCountryProvinces.map((p) => ({ id: p.id, name: `${p.name} (${p.count})` }))
                        : countryGroups.map((g) => ({ id: g.id, name: `${g.name} (${g.count})` }))
                    }
                    selectedId={null}
                    onSelectItem={openCountryId ? setSelectedRegionId : openCountry}
                  />
                </div>
              )}
            </div>
          )}
          {data.items.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  viewBox="0 0 24 24"
                  className="h-6 w-6 text-muted"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 3l18 18" />
                  <path d="M10.6 5.2A9.4 9.4 0 0 1 12 5c5.5 0 9 5 9 7a11 11 0 0 1-3 3.4M6.1 6.1C3.9 7.7 2.5 10 2.5 12c0 2 3.5 7 9.5 7 1.5 0 2.8-.3 4-.8" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </svg>
              }
              title="Nothing hidden yet"
              description={`Use "Hide from this region" on a species card in your collection to keep a vagrant or one-off record off that region's checklist without touching its global record.`}
            />
          ) : displayedItems.length === 0 ? (
            <p className="text-muted">No hidden species match "{search}".</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <p className="text-sm font-medium text-ink">
                  {displayedItems.length} species <span className="font-normal text-muted">in {scopeLabel}</span>
                </p>
                <button
                  onClick={unhideScope}
                  disabled={bulkBusy}
                  className="text-xs text-muted hover:text-ink hover:underline disabled:opacity-50"
                >
                  {bulkBusy ? "Unhiding…" : "Unhide all shown"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                {displayedItems.map((item) => (
                  <div key={item.speciesId} className="rounded-lg border border-line bg-surface p-2">
                    <Link to={`/species/${item.speciesId}`} state={{ backLabel: "Hidden species" }} className="block">
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
                      <p className="mt-1 truncate text-xs font-medium text-ink">
                        {item.commonName ?? item.scientificName}
                      </p>
                      <p className="truncate text-[10px] italic text-muted">{item.scientificName}</p>
                    </Link>
                    <button
                      onClick={() => unhideOne(item)}
                      disabled={busyIds.has(item.speciesId)}
                      className="mt-1 w-full rounded border border-line py-0.5 text-[10px] uppercase tracking-wide text-muted hover:bg-surface-muted disabled:opacity-50"
                    >
                      {busyIds.has(item.speciesId) ? "…" : "Unhide"}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </main>
      )}
    </div>
  );
}
