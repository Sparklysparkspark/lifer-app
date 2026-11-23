import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { matches } from "../lib/keymap";
import { Trans, useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import type { RegionSummary } from "@lifer/shared";
import { useRegions } from "../hooks/useRegions";
import { downloadedTaxaByCountry, usePackIndex } from "../lib/packIndex";
import { regionsReachableFrom } from "../lib/regionGrouping";
import { regionCollapse } from "../lib/regionCollapse";
import {
  realmsOf,
  recentRegionIds,
  regionLabel,
  regionPartOf,
  rememberRegion,
  searchExampleRegion,
  searchRegions,
} from "../lib/regionSearch";
import RegionPicker from "./RegionPicker";
import SearchInput from "./SearchInput";
import { ignore } from "../lib/ignore";
import { backStateFor } from "../lib/backLabel";
import Button from "./Button";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";

const NO_REGIONS: RegionSummary[] = [];
const NO_IDS: Set<string> = new Set();

/** A search result: the name, with what it is part of in the muted text beside it. */
function PartOfLabel({ region, partOf }: { region: RegionSummary; partOf: string | null }) {
  const { t } = useTranslation();
  return (
    <>
      {region.name}
      {partOf && <span className="text-muted">, {t("regionBrowser.partOf", { name: partOf })}</span>}
    </>
  );
}

// The collection's breadcrumb and drill-in picking, limited to regions reachable from a downloaded
// country pack. allowAnyRegion lifts that restriction.
export default function RegionBrowser({
  regionId,
  onChange,
  allowAnyRegion,
  restrictToIds,
  suggestedRegionIds,
  hint,
  size,
  searchOnly,
}: {
  regionId: string | null;
  onChange: (id: string | null) => void;
  allowAnyRegion?: boolean;
  /** Overrides which regions are pickable (e.g. Gallery: only regions with photos). Use with
   *  allowAnyRegion so it replaces the pack restriction instead of intersecting it. */
  restrictToIds?: Set<string> | null;
  /** Quick picks from the caller's context (the photo's region, the page's region filter),
   *  shown before the user's recent picks. */
  suggestedRegionIds?: ReadonlyArray<string | null | undefined>;
  /** One line under the search field, as a form field's hint. */
  hint?: string;
  size?: "sm" | "md";
  /** Only the search and quick picks, no browsing: for a picker that adds regions to a list. */
  searchOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [term, setTerm] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds] = useState(recentRegionIds);
  const listboxId = useId();
  const hintId = useId();
  const location = useLocation();
  const { regions, error: regionsError, refresh: refreshRegions } = useRegions();
  const allRegions = regions ?? NO_REGIONS;
  const { packs } = usePackIndex(!allowAnyRegion);
  // Unknown until the list arrives (and if it can't), never "nothing downloaded": the server lists
  // installed packs even offline. Meanwhile nothing is pickable, never every region.
  const downloadedCountryNames = useMemo(
    () => (packs ? new Set(downloadedTaxaByCountry(packs).keys()) : null),
    [packs],
  );

  // Same as the collection's: a downloaded country, its ancestors up to World, and every
  // descendant bundled in its pack.
  const availableRegionIds = useMemo(() => {
    if (restrictToIds) return restrictToIds;
    if (allowAnyRegion) return null;
    if (!downloadedCountryNames) return NO_IDS;
    return regionsReachableFrom(allRegions, downloadedCountryNames);
  }, [allRegions, downloadedCountryNames, restrictToIds, allowAnyRegion]);
  // Whether availableRegionIds is the real answer, not the stand-in while the pack list loads.
  const listKnown = !!restrictToIds || allowAnyRegion || !!downloadedCountryNames;

  const worldRegion = useMemo(() => allRegions.find((r) => r.parentId === null && r.name === "World"), [allRegions]);
  // Like the Collection, a group holding one province is listed as, and stands in for, that province.
  const collapse = useMemo(() => regionCollapse(allRegions, availableRegionIds), [allRegions, availableRegionIds]);
  const allChildren = useMemo(
    () => allRegions.filter((r) => r.parentId === (regionId && collapse.target(regionId))),
    [allRegions, regionId, collapse],
  );
  const children = useMemo(() => (regionId ? collapse.areasOf(regionId) : []), [regionId, collapse]);
  const byId = useMemo(() => new Map(allRegions.map((r) => [r.id, r])), [allRegions]);
  const reachable = (id: string) => byId.has(id) && (!availableRegionIds || availableRegionIds.has(id));
  const results = useMemo(
    () => (term.trim() ? searchRegions(allRegions, byId, term, availableRegionIds) : []),
    [allRegions, byId, term, availableRegionIds],
  );
  const realms = useMemo(
    () =>
      realmsOf(allRegions, regionId ? byId.get(regionId) : undefined).filter(
        (r) => !availableRegionIds || availableRegionIds.has(r.id),
      ),
    [allRegions, byId, regionId, availableRegionIds],
  );
  const suggestions = [...new Set([...(suggestedRegionIds ?? []), ...recentIds])].filter(
    (id): id is string => !!id && id !== regionId && reachable(id),
  );
  const example = searchExampleRegion(byId, suggestedRegionIds ?? []);
  // A choice the user made, as opposed to the fallback below; remembered for the suggestions.
  function pick(id: string | null) {
    if (id) rememberRegion(byId, id);
    setTerm("");
    onChange(id);
  }
  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (matches(e, "listNext") || matches(e, "listPrevious")) {
      e.preventDefault();
      const step = matches(e, "listNext") ? 1 : -1;
      setActiveIndex((i) => (i + step + results.length) % results.length);
    } else if (matches(e, "choose")) {
      // Inside a form (a photo's location editor) Enter would otherwise submit it.
      e.preventDefault();
      pick(results[Math.min(activeIndex, results.length - 1)].id);
    }
  }
  const breadcrumb = useMemo(() => collapse.trail(regionId), [collapse, regionId]);

  // A stored regionId that no longer resolves (an offloaded pack, a fresh database with new ids)
  // falls back to nothing, or to the only downloaded country when there's exactly one.
  const onlyCountryId = useMemo(() => {
    if (restrictToIds || allowAnyRegion || !downloadedCountryNames || downloadedCountryNames.size !== 1) return null;
    const onlyName = [...downloadedCountryNames][0];
    return allRegions.find((r) => r.name === onlyName && availableRegionIds?.has(r.id))?.id ?? null;
  }, [restrictToIds, allowAnyRegion, downloadedCountryNames, allRegions, availableRegionIds]);
  useEffect(() => {
    // A remembered region stays until the pack list says whether it's still downloaded.
    if (!allRegions.length || !availableRegionIds || !listKnown) return;
    if (regionId && availableRegionIds.has(regionId)) return;
    const next = onlyCountryId;
    if (next !== regionId) onChange(next);
  }, [regionId, allRegions, availableRegionIds, listKnown, onlyCountryId, onChange]);
  const noPacks = !restrictToIds && !allowAnyRegion && downloadedCountryNames?.size === 0;

  if (!regions && regionsError) {
    return (
      <p className="text-callout text-muted">
        {t("regionBrowser.loadFailed")}{" "}
        <Button
          variant="link"
          onClick={() => void refreshRegions().catch(ignore("Couldn't reload the region list"))}
          className="text-ink! underline"
        >
          {t("regionBrowser.tryAgain")}
        </Button>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {noPacks ? (
        <p className="text-callout text-muted">
          <Trans
            i18nKey="regionBrowser.noPacks"
            components={{
              a: <Link to={SPECIES_DOWNLOADS_PATH} state={backStateFor(location, t)} className="text-ink underline" />,
            }}
          />
        </p>
      ) : (
        <>
          <SearchInput
            value={term}
            onChange={(value) => {
              setTerm(value);
              setActiveIndex(0);
            }}
            onKeyDown={onSearchKey}
            placeholder={
              example ? t("regionBrowser.searchPlaceholder", { name: example.name }) : t("regionBrowser.searchLabel")
            }
            aria-label={t("regionBrowser.searchLabel")}
            size={size}
            inputProps={{
              role: "combobox",
              "aria-expanded": results.length > 0,
              "aria-controls": listboxId,
              "aria-activedescendant": results.length > 0 ? `${listboxId}-${activeIndex}` : undefined,
              autoComplete: "off",
              "aria-describedby": hint ? hintId : undefined,
            }}
          />
          {hint && !term.trim() && (
            <p id={hintId} className="text-subheadline text-muted">
              {hint}
            </p>
          )}
          {term.trim() &&
            (results.length > 0 ? (
              <ul
                id={listboxId}
                role="listbox"
                className="overflow-hidden rounded-panel border border-line bg-surface py-1"
              >
                {results.map((r, i) => (
                  <li
                    key={r.id}
                    id={`${listboxId}-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    onClick={() => pick(r.id)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={`cursor-pointer px-3 py-1.5 text-callout text-ink ${i === activeIndex ? "bg-surface-muted" : ""}`}
                  >
                    <PartOfLabel region={r} partOf={regionPartOf(byId, r)} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-footnote text-muted">{t("regionBrowser.noMatches")}</p>
            ))}
          {/* Quick picks and the way into browsing, one secondary row at the chips' size. */}
          {((!term.trim() && suggestions.length > 0) || (!regionId && worldRegion && !searchOnly)) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-footnote">
              {!term.trim() && suggestions.length > 0 && (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-muted">{t("regionBrowser.suggested")}</span>
                  <RegionPicker
                    mode="single"
                    items={suggestions.map((id) => ({ id, name: regionLabel(byId, byId.get(id)!) }))}
                    selectedId={null}
                    onSelectItem={pick}
                  />
                </div>
              )}
              {!regionId && worldRegion && !searchOnly && (
                <Button variant="link" onClick={() => pick(worldRegion.id)} className="font-medium text-link!">
                  {t("regionBrowser.browse")}
                </Button>
              )}
            </div>
          )}
          {regionId && (
            <nav className="flex flex-wrap items-baseline gap-1 text-callout text-muted">
              <Button variant="link" onClick={() => pick(null)} className="text-link!">
                {t("regionBrowser.allRegions")}
              </Button>
              {breadcrumb.map((r, i) => (
                <span key={r.id} className="flex items-baseline gap-1">
                  <span className="text-muted">/</span>
                  {i === breadcrumb.length - 1 ? (
                    <span className="font-medium text-ink">{r.name}</span>
                  ) : (
                    <Button variant="link" onClick={() => pick(r.id)} className="text-link!">
                      {r.name}
                    </Button>
                  )}
                </span>
              ))}
            </nav>
          )}
        </>
      )}
      {regionId && children.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-footnote text-muted">{t("regionBrowser.drillIn")}</span>
          <RegionPicker mode="single" items={children} selectedId={null} onSelectItem={pick} />
        </div>
      )}
      {regionId && realms.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-footnote text-muted">
            {t("regionBrowser.realms", { name: byId.get(regionId)?.name })}
          </span>
          <RegionPicker mode="single" items={realms} selectedId={null} onSelectItem={pick} />
        </div>
      )}
      {regionId && listKnown && availableRegionIds && allChildren.length > 0 && children.length === 0 && (
        <p className="text-footnote text-muted">{t("regionBrowser.noCountries")}</p>
      )}
    </div>
  );
}
