import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import ManageListPage, { ManageList, RowThumb } from "../components/ManageListPage";
import { docsUrl } from "../lib/docs";
import RegionPicker from "../components/RegionPicker";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { formatList } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";

const HIDDEN_INFO_PARAGRAPH_KEYS = ["hiddenSpecies.info.region", "hiddenSpecies.info.country"];

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
// one-level "Drill in" pills as RegionBrowser; the list below always matches the current scope.
export default function HiddenSpeciesPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [data, setData] = useState<HiddenResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [search, setSearch] = useState("");
  const confirm = useConfirm();
  const toast = useToast();
  // openCountryId: the country drilled into (narrows to all of it). selectedRegionId: one
  // province within it, or the country's own "Whole country" leaf.
  const [pickedCountryId, setOpenCountryId] = useState<string | null>(null);
  const [pickedRegionId, setSelectedRegionId] = useState<string | null>(null);
  // Auto-drill into a lone country only on first load, not on every refetch after an unhide.
  const autoOpenedRef = useRef(false);

  function openCountry(id: string) {
    setOpenCountryId(id);
    setSelectedRegionId(null);
  }

  // A refetch after an unhide keeps the current list up instead of flashing a spinner.
  function fetchHidden() {
    api
      .get("/regions/hidden-species")
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
  // After an unhide empties the open country or province, the page falls back up a level rather
  // than show a blank crumb over an empty list (ux-rules N7).
  const openCountryGroup = pickedCountryId ? countryGroups.find((g) => g.id === pickedCountryId) : undefined;
  const openCountryId = openCountryGroup?.id ?? null;
  // The open country's provinces with something hidden, plus a "Whole country" leaf when the
  // country itself has direct hides.
  const openCountryProvinces = useMemo(() => {
    if (!openCountryGroup) return [];
    return [
      ...(openCountryGroup.hasCountryLevel
        ? [
            {
              id: openCountryGroup.id,
              name: t("hiddenSpecies.wholeCountry"),
              count: openCountryGroup.countryLevelCount,
            },
          ]
        : []),
      ...openCountryGroup.provinces,
    ];
  }, [openCountryGroup, t]);
  const selectedRegionId = openCountryProvinces.some((p) => p.id === pickedRegionId) ? pickedRegionId : null;

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
    : (openCountryGroup?.name ?? t("hiddenSpecies.allScope"));

  async function unhideOne(item: HiddenItem) {
    setBusyIds((prev) => new Set(prev).add(item.speciesId));
    try {
      // A country-level unhide asks about the provinces under it rather than silently leaving
      // them hidden or silently unhiding them (hiding cascades; unhiding deliberately asks).
      let cascadeRegionIds: string[] = [];
      if (item.isCountry) {
        const res = await api.get(
          apiPath("/regions/{regionId}/species/{speciesId}/hidden-children", {
            regionId: item.regionId,
            speciesId: item.speciesId,
          }),
        );
        if (res.children.length > 0) {
          const names = formatList(
            res.children.map((c) => c.regionName),
            "unit",
          );
          // confirm-ok: a choice between two scopes, not a guard on a reversible action.
          const alsoChildren = await confirm({
            title: t("hiddenSpecies.unhideChildren.title", { names }),
            message: t("hiddenSpecies.unhideChildren.message", { count: res.children.length }),
            confirmLabel: t("hiddenSpecies.unhideChildren.confirm"),
            cancelLabel: t("hiddenSpecies.unhideChildren.cancel"),
          });
          if (alsoChildren) cascadeRegionIds = res.children.map((c) => c.regionId);
        }
      }
      const query = cascadeRegionIds.length > 0 ? `?cascadeRegionIds=${cascadeRegionIds.join(",")}` : "";
      await api.delete(`/regions/${item.regionId}/species/${item.speciesId}/hide${query}`);
      const rows = [item.regionId, ...cascadeRegionIds].map((regionId) => ({ regionId, speciesId: item.speciesId }));
      announceUnhidden(1, rows);
    } catch {
      toast.error(t("hiddenSpecies.unhideFailed"));
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(item.speciesId);
        return next;
      });
      load();
    }
  }

  // Unhiding is reversible, so it acts at once and offers Undo, which puts back the same rows.
  function announceUnhidden(count: number, rows: { regionId: string; speciesId: string }[]) {
    const undo = () =>
      api
        .post("/regions/hidden-species/bulk", { items: rows })
        .catch(() => toast.error(t("hiddenSpecies.undoFailed")))
        .finally(load);
    toast.show(t("hiddenSpecies.unhidToast", { count }), { actions: [{ label: t("common.undo"), onClick: undo }] });
  }

  // One request over the raw rows, so a country-wide hide also clears every province row under it.
  async function unhideScope() {
    const rows = scopedItems.map((i) => ({ regionId: i.regionId, speciesId: i.speciesId }));
    setBulkBusy(true);
    try {
      await api.delete("/regions/hidden-species/bulk", { items: rows });
      announceUnhidden(new Set(rows.map((r) => r.speciesId)).size, rows);
    } catch {
      toast.error(t("hiddenSpecies.unhideGroupFailed"));
    } finally {
      setBulkBusy(false);
      load();
    }
  }

  const title = t("hiddenSpecies.title");
  return (
    <ManageListPage
      title={title}
      backLabel={t("nav.settings")}
      description={t("hiddenSpecies.description")}
      help={HIDDEN_INFO_PARAGRAPH_KEYS.map((key) => t(key))}
      docsHref={docsUrl("/guides/collection-and-checklists#undoing-hide-and-archive")}
      search={{ value: search, onChange: setSearch, placeholder: t("hiddenSpecies.searchPlaceholder") }}
      actions={
        displayedItems.length > 0 && (
          <Button variant="secondary" size="sm" onClick={unhideScope} loading={bulkBusy}>
            {bulkBusy ? t("hiddenSpecies.unhiding") : t("hiddenSpecies.unhideAllShown")}
          </Button>
        )
      }
      loading={!data}
      error={loadError ? t("hiddenSpecies.loadFailed") : null}
      onRetry={load}
      isEmpty={data?.items.length === 0}
      empty={{
        icon: (
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
        ),
        title: t("hiddenSpecies.empty.title"),
        description: t("hiddenSpecies.empty.description"),
      }}
    >
      {countryGroups.length > 0 && (
        <div className="space-y-2">
          <nav className="flex flex-wrap items-center gap-1 text-callout text-muted">
            <Button
              variant="link"
              onClick={() => {
                setOpenCountryId(null);
                setSelectedRegionId(null);
              }}
            >
              {t("hiddenSpecies.allCountries")}
            </Button>
            {openCountryGroup && (
              <span className="flex items-center gap-1">
                <span className="text-muted">/</span>
                {selectedRegionId ? (
                  <Button variant="link" onClick={() => setSelectedRegionId(null)}>
                    {openCountryGroup.name}
                  </Button>
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
              <span className="text-footnote text-muted">{t("hiddenSpecies.drillIn")}</span>
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
      {displayedItems.length === 0 ? (
        <EmptyState
          compact
          title={
            search.trim()
              ? t("hiddenSpecies.noMatch", { search })
              : t("hiddenSpecies.noneInScope", { scope: scopeLabel ?? t("hiddenSpecies.allScope") })
          }
        />
      ) : (
        <>
          <p className="text-subheadline font-medium text-ink">
            <Trans
              i18nKey="hiddenSpecies.count"
              values={{ count: displayedItems.length, scope: scopeLabel }}
              components={{ muted: <span className="font-normal text-muted" /> }}
            />
          </p>
          <ManageList
            label={title}
            rows={displayedItems.map((item) => ({
              key: `${item.speciesId}:${item.regionId}`,
              thumb: <RowThumb src={item.referenceThumbUrl ?? item.referencePhoto} alt="" />,
              primary: speciesName(item),
              // The region shares the second line, so a long name keeps the row's width.
              secondary: (
                <>
                  <i>{item.scientificName}</i> · {item.regionName}
                </>
              ),
              to: `/species/${item.speciesId}`,
              linkState: { backLabel: title },
              menu: [
                {
                  label: busyIds.has(item.speciesId) ? t("hiddenSpecies.unhiding") : t("hiddenSpecies.unhide"),
                  disabled: busyIds.has(item.speciesId),
                  onSelect: () => void unhideOne(item),
                },
              ],
            }))}
          />
        </>
      )}
    </ManageListPage>
  );
}
