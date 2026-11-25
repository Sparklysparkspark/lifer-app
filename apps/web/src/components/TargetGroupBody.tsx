import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { isGrowthFormQuery, NAME_MAX_LENGTH, parseListPhrase, type RegionSummary } from "@lifer/shared";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useRegions } from "../hooks/useRegions";
import { useSettings } from "../hooks/useSettings";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import {
  announceListsChanged,
  bestPlace,
  bestTaxon,
  listCallError,
  runPlaces,
  runTaxa,
  useSearch,
  type ListPreview,
  type PlaceHit,
  type TaxonHit,
} from "../lib/speciesLists";
import { useSpeciesName } from "../lib/speciesName";
import { regionListsFirst, targetListsChanged, useTargetLists } from "../lib/targetLists";
import { PickChip } from "./AddSpeciesListModal";
import Button from "./Button";
import FormMessage from "./FormMessage";
import SearchInput from "./SearchInput";
import Select from "./Select";
import { ModalFooter, useModalSubmit } from "./SlotModal";
import Switch from "./Switch";

type GroupPreview = ApiResponse<"/collection/targets/by-group">;
type Loaded<T> = { key: string; value?: T; error?: unknown };

const DEBOUNCE_MS = 300;
const MAX_PLACES = 8;
const FIELD_LABEL = "block space-y-1 text-callout text-muted";

/** `load` for `key` after a pause in typing, tagged with its key so a stale reply never shows. */
function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loaded<T> | null {
  const [state, setState] = useState<Loaded<T> | null>(null);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      load(controller.signal)
        .then((value) => !controller.signal.aborted && setState({ key, value }))
        .catch((error: unknown) => !controller.signal.aborted && setState({ key, error }));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // The key carries every input the load depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state : null;
}

/** Lifer regions for the place words (exact name or alias first, then by prefix); the region in view
 *  when there are none. */
function placeRegions(regions: RegionSummary[], query: string | null, viewedId: string | null): RegionSummary[] {
  if (!query) return regions.filter((r) => r.id === viewedId);
  const q = query.trim().toLowerCase();
  const exact = regions.filter((r) => r.name.toLowerCase() === q || r.aliases?.some((a) => a.toLowerCase() === q));
  const prefix = regions.filter((r) => !exact.includes(r) && r.name.toLowerCase().startsWith(q));
  return [...exact, ...prefix].slice(0, MAX_PLACES);
}

/** "Raptors of BC": one box, the group and place chips, a live count, the target list, and one
 *  button. A group Lifer's catalog holds is targeted from the downloaded checklist at once; any
 *  other (mushrooms, butterflies) becomes a list from iNaturalist whose species become targets as
 *  they arrive, in the background. Undo is in the toast afterwards. */
export default function TargetGroupBody({
  regionId = null,
  regionName = null,
  onClose,
  onChanged,
}: {
  /** The region in view: the place when the phrase names none. */
  regionId?: string | null;
  regionName?: string | null;
  onClose: () => void;
  /** After targets were added or taken back. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const inatOn = !!useSettings().settings?.anyTaxaSearchEnabled;
  const lists = useTargetLists();
  const { regions } = useRegions();

  const [text, setText] = useState("");
  const [listId, setListId] = useState("");
  const [includePhotographed, setIncludePhotographed] = useState(false);
  // A pick from a chip holds while the words it was made for stay the same.
  const [regionPick, setRegionPick] = useState<{ query: string; id: string } | null>(null);
  const [taxonPick, setTaxonPick] = useState<{ query: string; hit: TaxonHit } | null>(null);
  const [placePick, setPlacePick] = useState<{ query: string; hit: PlaceHit } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const phrase = parseListPhrase(text);
  const taxonQuery = phrase.taxonQuery;
  const placeQuery = phrase.placeQuery;
  const placeWords = placeQuery ?? "";

  // Lifer's catalog first.
  const regionOptions = placeRegions(regions ?? [], placeQuery, regionId);
  const region =
    (regionPick?.query === placeWords && regionOptions.find((r) => r.id === regionPick.id)) || regionOptions[0] || null;
  const catalogKey = taxonQuery.length >= 2 ? JSON.stringify([taxonQuery, region?.id, includePhotographed]) : null;
  const catalog = useLoad<GroupPreview>(catalogKey, (signal) =>
    api.get(
      apiPath(
        "/collection/targets/by-group",
        {},
        { q: taxonQuery, regionId: region?.id, includePhotographed: includePhotographed ? "1" : undefined },
      ),
      { signal },
    ),
  );
  const group = catalog?.value?.group ?? null;

  // Not a catalog group: iNaturalist, when its search is on.
  const inatMode = !!catalog?.value && !group && inatOn && !isGrowthFormQuery(taxonQuery);
  const inatPlaceQuery = phrase.placeQuery ?? regionName;
  const taxa = useSearch(inatMode ? taxonQuery : null, runTaxa);
  const places = useSearch(inatMode ? inatPlaceQuery : null, runPlaces);
  const taxon = taxonPick?.query === taxonQuery ? taxonPick.hit : taxa ? bestTaxon(taxa.results) : null;
  const place =
    placePick?.query === inatPlaceQuery
      ? placePick.hit
      : places
        ? bestPlace(places.results, phrase.placeQuery ? null : regionId)
        : null;
  const inatKey = inatMode && taxon && place ? `${taxon.taxonId}:${place.placeId}` : null;
  const inat = useLoad<ListPreview>(inatKey, (signal) =>
    api.post("/species-lists/preview", { taxonId: taxon!.taxonId, placeId: place!.placeId }, { signal }),
  );

  const count = group ? (catalog?.value?.count ?? null) : inatMode ? (inat?.value?.count ?? null) : null;
  const newName = text.trim().slice(0, NAME_MAX_LENGTH);
  const ready = group ? !!region : !!place?.regionId;
  const canAdd = !saving && !!count && ready && (!!listId || !!newName);
  const orderedLists = useMemo(() => regionListsFirst(lists ?? [], regionId), [lists, regionId]);
  const existing = lists?.find((l) => l.id === listId);
  const listName = existing?.name ?? newName;
  const destination = existing ? { listId: existing.id } : { name: newName };

  function changed() {
    targetListsChanged();
    onChanged?.();
  }

  async function addFromCatalog() {
    const res = await api.post("/collection/targets/by-group", {
      q: taxonQuery,
      regionId: region!.id,
      includePhotographed,
      ...destination,
    });
    changed();
    onClose();
    const undo = () =>
      api
        .post("/target-lists/import/undo", res)
        .then(() => {
          changed();
          toast.success(t("targetLists.group.undone"));
        })
        .catch(() => toast.error(t("targetLists.group.undoFailed")));
    toast.show(t("targetLists.import.done", { count: res.addedSpeciesIds.length, name: listName }), {
      tone: "success",
      actions: [{ label: t("species.edits.undo"), onClick: () => void undo() }],
    });
  }

  async function addFromInat() {
    const res = await api.post("/species-lists", {
      taxonId: taxon!.taxonId,
      taxonName: taxon!.commonName ?? taxon!.name,
      taxonRank: taxon!.rank ?? undefined,
      placeId: place!.placeId,
      placeName: place!.name,
      regionId: place!.regionId ?? undefined,
      targets: { ...destination, photographed: includePhotographed },
    });
    announceListsChanged();
    changed();
    onClose();
    const undo = () =>
      api
        .post(apiPath("/species-lists/{id}/untarget", { id: res.list.id }))
        .then(() => {
          announceListsChanged();
          changed();
          toast.success(t("targetLists.group.undone"));
        })
        .catch(() => toast.error(t("targetLists.group.undoFailed")));
    toast.show(t("targetLists.group.adding", { name: res.list.name }), {
      tone: "success",
      actions: [{ label: t("species.edits.undo"), onClick: () => void undo() }],
    });
  }

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!canAdd) return;
    setSaving(true);
    setSaveError(null);
    try {
      await (group ? addFromCatalog() : addFromInat());
    } catch (err) {
      setSaveError(group ? errorMessage(err, t("targetLists.group.failed")) : listCallError(err));
      setSaving(false);
    }
  }
  useModalSubmit((e) => void save(e));

  const examples = group ? (catalog?.value?.examples ?? []) : (inat?.value?.examples ?? []);
  const searching =
    (!!catalogKey && !catalog) ||
    (inatMode && ((!!taxonQuery && !taxa) || (!!inatPlaceQuery && !places) || (!!inatKey && !inat)));
  // At most one line of help and one problem, the most useful first.
  const hint =
    taxonQuery.length < 2 || !catalog?.value
      ? null
      : group
        ? phrase.placeQuery && !region
          ? t("speciesLists.add.noPlace", { query: phrase.placeQuery })
          : !region
            ? t("speciesLists.add.needPlace")
            : count === 0
              ? t("targetLists.group.none", { region: region.name })
              : null
        : !inatOn
          ? t("targetLists.group.notInCatalog", { query: taxonQuery })
          : isGrowthFormQuery(taxonQuery)
            ? t("speciesLists.add.growthForm", { query: taxonQuery })
            : taxa && !taxa.error && taxa.results.length === 0
              ? t("speciesLists.add.noGroup", { query: taxonQuery })
              : taxon && !inatPlaceQuery
                ? t("speciesLists.add.needPlace")
                : null;
  const problem =
    saveError ??
    (catalog?.error
      ? errorMessage(catalog.error, t("targetLists.group.failed"))
      : taxa?.error
        ? listCallError(taxa.error)
        : places?.error
          ? listCallError(places.error)
          : place && !place.regionId
            ? t("speciesLists.errors.noRegion")
            : inat?.error
              ? listCallError(inat.error)
              : null);

  return (
    <>
      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canAdd} loading={saving}>
          {count ? t("targetLists.import.confirm", { count }) : t("targetLists.addTitle")}
        </Button>
      </ModalFooter>
      <div className="space-y-3">
        <p className="text-callout text-muted">{t("targetLists.group.description")}</p>
        <SearchInput
          value={text}
          onChange={setText}
          autoFocus
          size="md"
          placeholder={t("targetLists.group.placeholder")}
          aria-label={t("speciesLists.add.fieldLabel")}
        />
        {group && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 max-w-full truncate rounded-control border border-line px-2 py-1 text-footnote text-ink">
              <span className="text-muted">{t("speciesLists.add.groupChip")} </span>
              {group}
            </span>
            {region && (
              <PickChip
                label={t("speciesLists.add.placeChip")}
                value={region.name}
                options={regionOptions}
                keyOf={(r) => r.id}
                onPick={(r) => setRegionPick({ query: placeWords, id: r.id })}
                render={(r) => <span className="block break-words text-ink">{r.name}</span>}
              />
            )}
          </div>
        )}
        {inatMode && (taxon || place) && (
          <div className="flex flex-wrap items-center gap-2">
            {taxon && (
              <PickChip
                label={t("speciesLists.add.groupChip")}
                value={taxon.commonName ?? taxon.name}
                options={taxa?.results ?? []}
                keyOf={(h) => h.taxonId}
                onPick={(hit) => setTaxonPick({ query: taxonQuery, hit })}
                render={(h) => <span className="block break-words text-ink">{h.commonName ?? h.name}</span>}
              />
            )}
            {place && (
              <PickChip
                label={t("speciesLists.add.placeChip")}
                value={place.name}
                options={places?.results ?? []}
                keyOf={(h) => h.placeId}
                onPick={(hit) => setPlacePick({ query: inatPlaceQuery ?? "", hit })}
                render={(h) => <span className="block break-words text-ink">{h.displayName}</span>}
              />
            )}
          </div>
        )}
        {!!count && (
          <div className="space-y-2 text-callout">
            <p className="text-ink">
              {!group
                ? t("targetLists.group.inatCount", { count })
                : includePhotographed
                  ? t("targetLists.group.countAll", { count })
                  : t("targetLists.group.count", { count })}
            </p>
            {examples.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label={t("speciesLists.add.examplesLabel")}>
                {examples.map((ex) => (
                  <li
                    key={ex.scientificName}
                    className="min-w-0 max-w-full truncate rounded-control border border-line px-2 py-0.5 text-footnote text-ink"
                  >
                    {speciesName(ex)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {(group || inatMode) && (
          <>
            <Select
              variant="form"
              label={t("targetLists.import.addTo")}
              labelClassName={FIELD_LABEL}
              value={listId}
              onChange={(e) => setListId(e.target.value)}
              className="w-full"
            >
              <option value="">
                {newName ? t("targetLists.group.newListNamed", { name: newName }) : t("targetLists.import.newList")}
              </option>
              {orderedLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.regionName ? t("targetLists.nameWithRegion", { name: l.name, region: l.regionName }) : l.name}
                </option>
              ))}
            </Select>
            <label className="flex items-center justify-between gap-3 text-callout text-ink">
              {t("targetLists.group.includePhotographed")}
              <Switch
                checked={includePhotographed}
                onChange={setIncludePhotographed}
                label={t("targetLists.group.includePhotographed")}
              />
            </label>
          </>
        )}
        {(hint || (searching && !problem)) && (
          <p className="text-footnote text-muted">{hint ?? t("targetLists.group.searching")}</p>
        )}
        <FormMessage error={problem} />
      </div>
    </>
  );
}
