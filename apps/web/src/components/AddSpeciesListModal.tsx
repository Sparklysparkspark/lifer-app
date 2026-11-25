import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isGrowthFormQuery, parseListPhrase, singularQuery } from "@lifer/shared";
import { api } from "../api/client";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { useRegions } from "../hooks/useRegions";
import { useToast } from "../hooks/useToast";
import { formatNumber } from "../lib/format";
import {
  announceListsChanged,
  LIST_BATCH_SIZE,
  listCallError,
  listErrorMessage,
  searchPlaces,
  searchTaxa,
  STARTER_LISTS,
  type ListPreview,
  type PlaceHit,
  type TaxonHit,
} from "../lib/speciesLists";
import { useSpeciesName } from "../lib/speciesName";
import Button from "./Button";
import FormMessage from "./FormMessage";
import Menu, { MenuItem, MenuPanel } from "./Menu";
import SlotModal, { ModalFooter, useModalSubmit } from "./SlotModal";
import Pill from "./Pill";
import ProgressiveImg from "./ProgressiveImg";
import SearchInput from "./SearchInput";
import Switch from "./Switch";

const DEBOUNCE_MS = 300;
const SPECIES_RANKS = new Set(["species", "subspecies", "variety", "form", "hybrid"]);

type Found<T> = { query: string; results: T[]; error?: unknown; unavailable?: string | null };

// A group (lists live above species rank) first, else iNaturalist's top hit.
const bestTaxon = (hits: TaxonHit[]) => hits.find((h) => !SPECIES_RANKS.has(h.rank ?? "")) ?? hits[0] ?? null;

// The region the Collection shows when the phrase names no place; otherwise a Lifer region, then a
// real administrative place, ahead of parks and towns with the same name.
function bestPlace(hits: PlaceHit[], preferRegionId: string | null): PlaceHit | null {
  return (
    (preferRegionId && hits.find((h) => h.regionId === preferRegionId)) ||
    hits.find((h) => h.regionId) ||
    hits.find((h) => h.adminLevel !== null) ||
    hits[0] ||
    null
  );
}

/** Debounced search for `query`, tagged with the query it answers so a stale reply never shows. */
function useSearch<T>(query: string | null, run: (q: string, signal: AbortSignal) => Promise<Found<T>>) {
  const [found, setFound] = useState<Found<T> | null>(null);
  useEffect(() => {
    if (!query || query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      run(query, controller.signal)
        .then((res) => !controller.signal.aborted && setFound(res))
        .catch((error: unknown) => !controller.signal.aborted && setFound({ query, results: [], error }));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, run]);
  return found && found.query === query ? found : null;
}

async function runTaxa(q: string, signal: AbortSignal): Promise<Found<TaxonHit>> {
  let results = await searchTaxa(q, signal);
  // Plurals are stripped only when the plain words find nothing (plan: "Common plurals").
  const single = singularQuery(q);
  if (results.length === 0 && single !== q && single.length >= 2) results = await searchTaxa(single, signal);
  return { query: q, results };
}
async function runPlaces(q: string, signal: AbortSignal): Promise<Found<PlaceHit>> {
  const res = await searchPlaces(q, signal);
  return { query: q, results: res.results, unavailable: res.inatUnavailable };
}

/** A chip showing the current pick that opens the other matches to choose from. */
function PickChip<T>({
  label,
  value,
  options,
  keyOf,
  render,
  onPick,
}: {
  label: string;
  value: string;
  options: T[];
  keyOf: (o: T) => number;
  render: (o: T) => React.ReactNode;
  onPick: (o: T) => void;
}) {
  const menu = useDropdownMenu();
  return (
    <Menu
      open={menu.openKey === true}
      onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
      menuRef={menu.ref}
      className="relative min-w-0 max-w-full"
      trigger={(props) => (
        <Button
          variant="secondary"
          size="sm"
          className="max-w-full min-w-0"
          aria-label={`${label}: ${value}`}
          {...props}
        >
          <span className="shrink-0 text-muted">{label}</span>
          <span className="truncate">{value}</span>
        </Button>
      )}
    >
      <MenuPanel align="left" className="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
        {options.map((o) => (
          <MenuItem key={keyOf(o)} onSelect={() => onPick(o)}>
            {render(o)}
          </MenuItem>
        ))}
      </MenuPanel>
    </Menu>
  );
}

// "Spiders of Canada": one box, two chips (group and place), a live count, and one button that
// starts the background job and closes at once (rule F2).
export default function AddSpeciesListModal(props: {
  regionId?: string | null;
  regionName?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <SlotModal onClose={props.onClose} title={t("speciesLists.add.title")}>
      <AddSpeciesListBody {...props} />
    </SlotModal>
  );
}

/** The dialog's content, also the "A group from iNaturalist" tab of Add other species. */
export function AddSpeciesListBody({
  regionId = null,
  regionName = null,
  onClose,
}: {
  /** The region the Collection is showing: the place when the phrase names none. */
  regionId?: string | null;
  regionName?: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const { regions } = useRegions();
  const regionById = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);

  const [text, setText] = useState("");
  const [nativeOnly, setNativeOnly] = useState(false);
  // A pick from a chip (or a starter) holds while the words it was made for stay the same.
  const [taxonPick, setTaxonPick] = useState<{ query: string; hit: TaxonHit } | null>(null);
  const [placePick, setPlacePick] = useState<{ query: string; hit: PlaceHit } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const phrase = parseListPhrase(text);
  const taxonQuery = phrase.taxonQuery;
  const growthForm = isGrowthFormQuery(taxonQuery);
  // No place words (or "near me", which needs a point the API can't take yet): the Collection's region.
  const placeQuery = phrase.placeQuery ?? regionName;
  const usingDefaultPlace = phrase.placeQuery === null;

  const taxa = useSearch(growthForm ? null : taxonQuery, runTaxa);
  const places = useSearch(placeQuery, runPlaces);
  const taxon = taxonPick?.query === taxonQuery ? taxonPick.hit : taxa && !growthForm ? bestTaxon(taxa.results) : null;
  const place =
    placePick?.query === placeQuery
      ? placePick.hit
      : places
        ? bestPlace(places.results, usingDefaultPlace ? regionId : null)
        : null;
  const targetRegion = place?.regionId ? regionById.get(place.regionId) : undefined;
  const targetRegionName = targetRegion?.name ?? place?.name ?? "";

  const previewKey = taxon && place ? `${taxon.taxonId}:${place.placeId}:${nativeOnly}` : null;
  const [preview, setPreview] = useState<{ key: string; result?: ListPreview; error?: unknown } | null>(null);
  useEffect(() => {
    if (!previewKey || !taxon || !place) return;
    const controller = new AbortController();
    api
      .post(
        "/species-lists/preview",
        { taxonId: taxon.taxonId, placeId: place.placeId, nativeOnly },
        { signal: controller.signal },
      )
      .then((result) => !controller.signal.aborted && setPreview({ key: previewKey, result }))
      .catch((error: unknown) => !controller.signal.aborted && setPreview({ key: previewKey, error }));
    return () => controller.abort();
    // The key carries every input the preview depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);
  const current = preview?.key === previewKey ? preview : null;
  const result = current?.result;

  const canAdd = !!result && result.count > 0 && !!place?.regionId && !creating;

  async function create(e?: FormEvent) {
    e?.preventDefault();
    if (!canAdd || !taxon || !place) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.post("/species-lists", {
        taxonId: taxon.taxonId,
        taxonName: taxon.commonName ?? taxon.name,
        taxonRank: taxon.rank ?? undefined,
        placeId: place.placeId,
        placeName: place.name,
        nativeOnly,
        regionId: place.regionId ?? undefined,
      });
      onClose();
      toast.success(
        res.created
          ? t("speciesLists.toast.adding", { name: res.list.name })
          : t("speciesLists.toast.alreadyAdded", { name: res.list.name }),
      );
      announceListsChanged();
    } catch (err) {
      setCreateError(listCallError(err));
      setCreating(false);
    }
  }

  function pickStarter(starter: (typeof STARTER_LISTS)[number]) {
    const label = t(starter.label);
    setText(phrase.placeQuery ? t("speciesLists.add.phrase", { group: label, place: phrase.placeQuery }) : label);
    setTaxonPick(
      starter.taxon
        ? {
            query: label,
            hit: {
              ...starter.taxon,
              commonName: label,
              iconicTaxon: null,
              observationsCount: null,
              thumbnailUrl: null,
            },
          }
        : null,
    );
  }

  const taxonLabel = (h: TaxonHit) => h.commonName ?? h.name;
  const rankName = (h: TaxonHit) => [h.rank, h.name].filter(Boolean).join(" ");
  const searching =
    (!!taxonQuery && taxonQuery.length >= 2 && !growthForm && !taxa) ||
    (!!placeQuery && !places) ||
    (!!previewKey && !current);

  // At most one line of help and one problem, the most useful first.
  const hint = growthForm
    ? t("speciesLists.add.growthForm", { query: taxonQuery })
    : taxa && !taxa.error && taxa.results.length === 0
      ? t("speciesLists.add.noGroup", { query: taxonQuery })
      : taxon && !placeQuery
        ? t("speciesLists.add.needPlace")
        : places && !places.unavailable && places.results.length === 0
          ? t("speciesLists.add.noPlace", { query: placeQuery })
          : null;
  const problem =
    createError ??
    (taxa?.error
      ? listCallError(taxa.error)
      : places?.error
        ? listCallError(places.error)
        : places?.unavailable && places.results.length === 0
          ? listErrorMessage(places.unavailable)
          : place && !place.regionId
            ? t("speciesLists.errors.noRegion")
            : current?.error
              ? listCallError(current.error)
              : null);

  useModalSubmit((e) => void create(e));

  return (
    <>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canAdd} loading={creating} className="min-w-0 max-w-full">
          <span className="truncate">
            {result && place?.regionId
              ? t("speciesLists.add.button", { count: result.count, region: targetRegionName })
              : t("speciesLists.add.buttonIdle")}
          </span>
        </Button>
      </ModalFooter>
      <div className="space-y-3">
        <p className="text-callout text-muted">{t("speciesLists.add.description")}</p>
        <SearchInput
          value={text}
          onChange={setText}
          autoFocus
          size="md"
          placeholder={t("speciesLists.add.placeholder")}
          aria-label={t("speciesLists.add.fieldLabel")}
        />
        {!taxonQuery && (
          <ul className="flex flex-wrap gap-2" aria-label={t("speciesLists.add.startersLabel")}>
            {STARTER_LISTS.map((s) => (
              <li key={s.label} className="min-w-0 max-w-full">
                <Pill size="sm" active={false} onClick={() => pickStarter(s)}>
                  {t(s.label)}
                </Pill>
              </li>
            ))}
          </ul>
        )}
        {(taxon || place) && (
          <div className="flex flex-wrap items-center gap-2">
            {taxon && (
              <PickChip
                label={t("speciesLists.add.groupChip")}
                value={
                  taxon.commonName
                    ? t("speciesLists.add.taxonValue", { name: taxon.commonName, what: rankName(taxon) })
                    : rankName(taxon)
                }
                options={taxa?.results ?? []}
                keyOf={(h) => h.taxonId}
                onPick={(hit) => setTaxonPick({ query: taxonQuery, hit })}
                render={(h) => (
                  <span className="flex min-w-0 items-center gap-2">
                    {h.thumbnailUrl ? (
                      <ProgressiveImg
                        thumbSrc={h.thumbnailUrl}
                        alt=""
                        className="h-8 w-8 shrink-0 rounded-badge object-cover"
                      />
                    ) : (
                      <span className="h-8 w-8 shrink-0 rounded-badge bg-surface-muted" />
                    )}
                    <span className="min-w-0">
                      <span className="block break-words text-ink">{taxonLabel(h)}</span>
                      <span className="block text-footnote text-muted">
                        {h.observationsCount != null
                          ? t("speciesLists.add.taxonDetail", { what: rankName(h), count: h.observationsCount })
                          : rankName(h)}
                      </span>
                    </span>
                  </span>
                )}
              />
            )}
            {place && (
              <PickChip
                label={t("speciesLists.add.placeChip")}
                value={place.name}
                options={places?.results ?? []}
                keyOf={(h) => h.placeId}
                onPick={(hit) => setPlacePick({ query: placeQuery ?? "", hit })}
                render={(h) => (
                  <span className="min-w-0">
                    <span className="block break-words text-ink">{h.displayName}</span>
                    {h.regionId && (
                      <span className="block text-footnote text-muted">{t("speciesLists.add.liferRegion")}</span>
                    )}
                  </span>
                )}
              />
            )}
          </div>
        )}
        {taxon && place && (
          <label className="flex items-center justify-between gap-3 text-callout text-ink">
            {t("speciesLists.add.nativeOnly")}
            <Switch checked={nativeOnly} onChange={setNativeOnly} label={t("speciesLists.add.nativeOnly")} />
          </label>
        )}
        {result && (
          <div className="space-y-2 text-callout">
            <p className="text-ink">
              {result.count === 0
                ? t("speciesLists.add.none", { place: place?.name ?? "" })
                : t("speciesLists.add.count", { count: result.count })}
            </p>
            {result.examples.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label={t("speciesLists.add.examplesLabel")}>
                {result.examples.map((ex) => (
                  <li
                    key={ex.taxonId}
                    className="min-w-0 max-w-full truncate rounded-control border border-line px-2 py-0.5 text-footnote text-ink"
                  >
                    {speciesName(ex)}
                  </li>
                ))}
              </ul>
            )}
            {result.count > 0 && (
              <p className="text-footnote text-muted">
                {result.batches > 1
                  ? t("speciesLists.add.bigList", {
                      batches: result.batches,
                      size: formatNumber(LIST_BATCH_SIZE),
                    })
                  : t("speciesLists.add.estimate", { minutes: Math.max(1, result.estimatedMinutes) })}
              </p>
            )}
          </div>
        )}
        {(hint || (searching && !problem)) && (
          <p className="text-footnote text-muted">{hint ?? t("speciesLists.add.searching")}</p>
        )}
        <FormMessage error={problem} />
      </div>
    </>
  );
}
