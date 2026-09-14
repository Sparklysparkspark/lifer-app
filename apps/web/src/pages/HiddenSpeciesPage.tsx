import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import PageHeader from "../components/PageHeader";
import InfoTip from "../components/InfoTip";
import { Spinner } from "../components/LoadingScreen";
import PhotoPlaceholder from "../components/PhotoPlaceholder";
import SearchInput from "../components/SearchInput";
import RegionPicker from "../components/RegionPicker";

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

// Management view for species hidden via SpeciesCard's "Hide from this region" action
// (region_species_hidden, migration 100). Navigation is the SAME breadcrumb + flat "Drill in:"
// pill row RegionBrowser.tsx uses for the import flow's own region picker — one level of pills
// at a time, navigated into via the breadcrumb — and it's the ONLY pill-like surface on this
// page. Earlier drafts also rendered a country-grouped SECTION below the pills (its own header
// repeating "Canada (2)" right under a "Canada (2)" pill that already said the same thing) —
// that's gone; the list below is always just one flat grid matching whatever scope the
// breadcrumb is currently on.
export default function HiddenSpeciesPage() {
  const [data, setData] = useState<HiddenResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState("");
  // openCountryId is "which country the breadcrumb has drilled into" (also narrows the list to
  // that whole country); selectedRegionId narrows further to one specific province picked from
  // that country's own drill-in row (or "just the country level" via a synthetic leaf — see
  // countryGroups below).
  const [openCountryId, setOpenCountryId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  // Only auto-drill into a single country once, right after the page's first load — not on
  // every refetch after a hide/unhide action, which would yank the user back in even after
  // they'd deliberately backed out to "All countries".
  const autoOpenedRef = useRef(false);

  function openCountry(id: string) {
    setOpenCountryId(id);
    setSelectedRegionId(null);
  }

  function load() {
    setLoadError(false);
    setData(null);
    api
      .get<HiddenResponse>("/regions/hidden-species")
      .then((res) => {
        setData(res);
        // Most users only ever have species hidden under one country — starting at "All
        // countries" when there's only ever going to be one option to pick is a pointless
        // extra click every time this page loads.
        if (!autoOpenedRef.current) {
          autoOpenedRef.current = true;
          const countryIds = [...new Set(res.items.map((i) => i.countryId).filter((id): id is string => !!id))];
          if (countryIds.length === 1) setOpenCountryId(countryIds[0]);
        }
      })
      .catch(() => setLoadError(true));
  }

  useEffect(load, []);

  // One entry per country that actually has a hidden species somewhere under it (itself or one
  // of its provinces) — a country with nothing hidden never appears. Provinces are looked up
  // separately, per country, only once that country is actually opened — a country with a dozen
  // provinces stays a single top-level pill until drilled into, same as RegionBrowser only ever
  // fetching/showing ONE level's children at a time.
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
        g = { id: item.countryId, name: item.countryName, speciesIds: new Set(), countryLevelCount: 0, provinces: new Map() };
        byId.set(item.countryId, g);
      }
      // A species cascade-hidden from the whole country still gets its own real row at every
      // province underneath it (see the hide endpoint's own comment) — that's deliberate, since
      // it's what lets a user later unhide it from just ONE province without touching the rest.
      // The count on a province's own pill below reflects that full, real total — including
      // cascade-inherited species, not just ones chosen specifically at that province — because
      // from that province's own point of view, they genuinely are hidden there right now.
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
        // Distinct species hidden ANYWHERE in this country — not a raw row count, which would
        // double (or worse) count a cascade-hidden species once per province it also touches.
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
  // Provinces to drill into, once a country's own pill is opened — plus a synthetic "Whole
  // country" leaf when the country itself has directly-hidden species (not just its provinces),
  // so that's still reachable as its own specific pick. Only ever lists provinces that actually
  // have a hidden species — nothing else is shown.
  const openCountryProvinces = useMemo(() => {
    if (!openCountryGroup) return [];
    return [
      ...(openCountryGroup.hasCountryLevel
        ? [{ id: openCountryGroup.id, name: "Whole country", count: openCountryGroup.countryLevelCount }]
        : []),
      ...openCountryGroup.provinces,
    ];
  }, [openCountryGroup]);

  // The raw, un-deduped rows in the current scope — used for search, the total count, and bulk
  // unhide (which must clear every underlying region row, not just what's shown as cards below).
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

  // A cascade hide writes one row per region (the country's own, plus every province) — without
  // narrowing to one exact province, the SAME species can show up once as the country's own row
  // and again under each province. Deduping to one card per species (preferring the country-
  // level row, whose own Unhide button is the one that knows to ask about cascading further) is
  // what actually avoids a pile of duplicate-looking cards. Only skipped once selectedRegionId
  // narrows to one exact region, where every row is already a distinct species.
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
      // Only a country-level hide can have province-level hides sitting underneath it —
      // check first and ask, rather than either silently leaving those provinces hidden (the
      // user has to notice and clean them up one at a time) or silently unhiding them too
      // (surprising, and the opposite of hiding's own automatic-cascade behavior, which is
      // deliberately asymmetric here — see this page's own info tip).
      let cascadeRegionIds: string[] = [];
      if (item.isCountry) {
        const res = await api.get<{ children: Array<{ regionId: string; regionName: string }> }>(
          `/regions/${item.regionId}/species/${item.speciesId}/hidden-children`,
        );
        if (res.children.length > 0) {
          const names = res.children.map((c) => c.regionName).join(", ");
          if (confirm(`Also unhide from ${names}?`)) cascadeRegionIds = res.children.map((c) => c.regionId);
        }
      }
      const query = cascadeRegionIds.length > 0 ? `?cascadeRegionIds=${cascadeRegionIds.join(",")}` : "";
      await api.delete(`/regions/${item.regionId}/species/${item.speciesId}/hide${query}`);
    } catch {
      alert("Couldn't unhide that species. Try again.");
    } finally {
      load();
    }
  }

  // One combined action for the whole current scope — asking once per species in a group of
  // dozens would be its own kind of annoying — using the raw scopedItems (every underlying
  // region row), not the deduped cards, so a country-wide hide actually clears every province
  // row underneath it too, not just the one card shown for it.
  async function unhideScope() {
    const uniqueSpeciesCount = new Set(scopedItems.map((i) => i.speciesId)).size;
    if (!confirm(`Unhide all ${uniqueSpeciesCount} species from "${scopeLabel}"?`)) return;
    setBulkBusy(true);
    try {
      await Promise.all(scopedItems.map((i) => api.delete(`/regions/${i.regionId}/species/${i.speciesId}/hide`)));
    } catch {
      alert("Couldn't unhide that group. Try again.");
    } finally {
      setBulkBusy(false);
      load();
    }
  }

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader sticky
        title="Hidden species"
        backFallbackTo="/settings"
        backLabel="Settings"
        titleAddon={<InfoTip paragraphs={HIDDEN_INFO_PARAGRAPHS} />}
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search hidden or a region…" className="w-56" />
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
            <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted">
                <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 3l18 18" />
                  <path d="M10.6 5.2A9.4 9.4 0 0 1 12 5c5.5 0 9 5 9 7a11 11 0 0 1-3 3.4M6.1 6.1C3.9 7.7 2.5 10 2.5 12c0 2 3.5 7 9.5 7 1.5 0 2.8-.3 4-.8" />
                  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                </svg>
              </div>
              <p className="text-sm font-medium text-ink">Nothing hidden yet</p>
              <p className="max-w-sm text-sm text-muted">
                Use "Hide from this region" on a species card in Collections to keep a vagrant or one-off record
                off that region's checklist without touching its global record.
              </p>
            </div>
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
