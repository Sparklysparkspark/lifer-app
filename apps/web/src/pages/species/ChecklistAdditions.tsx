import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Button, { IconButton } from "../../components/Button";
import Panel from "../../components/Panel";
import Pill from "../../components/Pill";
import RegionBrowser from "../../components/RegionBrowser";
import SearchInput from "../../components/SearchInput";
import SegmentedControl from "../../components/SegmentedControl";
import { useRegions } from "../../hooks/useRegions";
import { useToast } from "../../hooks/useToast";
import {
  addToChecklist,
  addedMessage,
  checklistLabel,
  listSeaZones,
  listSpeciesChecklistAdditions,
  regionHasChecklist,
  removeFromChecklist,
  seaZoneViewPath,
  type ChecklistTarget,
  type SeaZoneSummary,
  type SpeciesChecklistAddition,
  type SpeciesSeaZoneAddition,
} from "../../lib/checklistAdditions";
import { errorMessage } from "../../lib/errorMessage";

type PickerMode = "region" | "seaZone";
const PICKER_MODES = [
  { value: "region", label: "species.checklists.modeRegion" },
  { value: "seaZone", label: "species.checklists.modeSeaZone" },
] as const;
// Enough matches to pick from without a long list pushing the buttons off a phone screen.
const SEA_ZONE_RESULTS = 8;

const normalize = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// One checklist you added the species to, removable. A sea zone links to a coastal region's view
// with that zone's water ticked, since a sea zone has no page of its own.
function AdditionChip({
  target,
  to,
  alsoListed,
  removing,
  onRemove,
}: {
  target: ChecklistTarget;
  to: string | null;
  alsoListed: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-control border border-dashed border-accent py-0.5 pl-2 pr-1 text-ink">
      {to ? (
        <Link to={to} className="truncate hover:underline">
          {target.name}
        </Link>
      ) : (
        <span className="truncate">{target.name}</span>
      )}
      {target.kind === "seaZone" && <span className="shrink-0 text-muted">{t("species.checklists.sea")}</span>}
      {alsoListed && (
        <span className="shrink-0 text-muted" title={t("species.checklists.alsoListedTitle")}>
          {t("species.checklists.alsoListed")}
        </span>
      )}
      <IconButton
        tone="plain"
        onClick={onRemove}
        disabled={removing}
        aria-label={t("species.checklists.removeFrom", { checklist: checklistLabel(target) })}
        className="shrink-0 leading-none"
      >
        ×
      </IconButton>
    </li>
  );
}

// The checklists you put this species on yourself, each removable, and (while `adding`) a picker
// to put it on another one: any country or province, or any sea zone. Not just downloaded ones.
export default function ChecklistAdditions({
  speciesId,
  speciesName,
  adding,
  onDoneAdding,
}: {
  speciesId: string;
  speciesName: string;
  adding: boolean;
  onDoneAdding: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { regions } = useRegions();
  const byId = useMemo(() => new Map((regions ?? []).map((r) => [r.id, r])), [regions]);
  const [regionAdditions, setRegionAdditions] = useState<SpeciesChecklistAddition[]>([]);
  const [seaZoneAdditions, setSeaZoneAdditions] = useState<SpeciesSeaZoneAddition[]>([]);
  const [mode, setMode] = useState<PickerMode>("region");
  const [regionId, setRegionId] = useState<string | null>(null);
  const [seaZones, setSeaZones] = useState<SeaZoneSummary[] | null>(null);
  const [seaZoneError, setSeaZoneError] = useState(false);
  const [zoneSearch, setZoneSearch] = useState("");
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(() => {
    listSpeciesChecklistAdditions(speciesId)
      .then((res) => {
        setRegionAdditions(res.items);
        setSeaZoneAdditions(res.seaZones);
      })
      .catch(() => {
        setRegionAdditions([]);
        setSeaZoneAdditions([]);
      });
  }, [speciesId]);
  useEffect(load, [load]);

  // The sea zone list is only needed once someone switches to it.
  useEffect(() => {
    if (!adding || mode !== "seaZone" || seaZones) return;
    let cancelled = false;
    listSeaZones()
      .then((zones) => {
        if (!cancelled) setSeaZones(zones);
      })
      .catch(() => {
        if (!cancelled) setSeaZoneError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [adding, mode, seaZones]);

  const zoneMatches = useMemo(() => {
    if (!seaZones) return [];
    const term = normalize(zoneSearch.trim());
    if (!term) return [];
    return seaZones.filter((z) => normalize(z.name).includes(term)).slice(0, SEA_ZONE_RESULTS);
  }, [seaZones, zoneSearch]);

  const pickedRegion = regionId ? byId.get(regionId) : undefined;
  const pickedZone = zoneId ? seaZones?.find((z) => z.id === zoneId) : undefined;
  const target: ChecklistTarget | null =
    mode === "region"
      ? pickedRegion && regionHasChecklist(pickedRegion, byId)
        ? { kind: "region", id: pickedRegion.id, name: pickedRegion.name }
        : null
      : pickedZone
        ? { kind: "seaZone", id: pickedZone.id, name: pickedZone.name }
        : null;

  async function add() {
    if (!target) return;
    setSaving(true);
    try {
      const result = await addToChecklist(target.id, speciesId, target.kind);
      toast.success(addedMessage(result, speciesName, target));
      setRegionId(null);
      setZoneId(null);
      setZoneSearch("");
      load();
      onDoneAdding();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't add it to that checklist. Try again."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(removed: ChecklistTarget) {
    setRemovingId(removed.id);
    try {
      await removeFromChecklist(removed.id, speciesId, removed.kind);
      toast.success(`Removed ${speciesName} from ${checklistLabel(removed)}.`);
      load();
    } catch (err) {
      toast.error(errorMessage(err, "Couldn't remove it from that checklist. Try again."));
    } finally {
      setRemovingId(null);
    }
  }

  const hasAdditions = regionAdditions.length + seaZoneAdditions.length > 0;
  if (!adding && !hasAdditions) return null;

  return (
    <div className="mt-2 space-y-2">
      {hasAdditions && (
        <div className="flex flex-wrap items-center gap-2 text-footnote text-muted">
          <span>{t("species.checklists.addedByYou")}</span>
          <ul className="flex min-w-0 flex-wrap items-center gap-2" aria-label={t("species.checklists.listLabel")}>
            {regionAdditions.map((a) => (
              <AdditionChip
                key={a.regionId}
                target={{ kind: "region", id: a.regionId, name: a.regionName }}
                to={`/?region=${a.regionId}`}
                alsoListed={a.alreadyOnChecklist}
                removing={removingId === a.regionId}
                onRemove={() => void remove({ kind: "region", id: a.regionId, name: a.regionName })}
              />
            ))}
            {seaZoneAdditions.map((a) => (
              <AdditionChip
                key={a.seaZoneId}
                target={{ kind: "seaZone", id: a.seaZoneId, name: a.seaZoneName }}
                to={seaZoneViewPath(a)}
                alsoListed={a.alreadyOnChecklist}
                removing={removingId === a.seaZoneId}
                onRemove={() => void remove({ kind: "seaZone", id: a.seaZoneId, name: a.seaZoneName })}
              />
            ))}
          </ul>
        </div>
      )}
      {adding && (
        <Panel className="space-y-3 text-callout" role="group" aria-label={t("species.detail.addToChecklist")}>
          <p className="text-footnote text-muted">{t("species.checklists.pickHint", { species: speciesName })}</p>
          <SegmentedControl
            value={mode}
            options={PICKER_MODES.map((m) => ({ ...m, label: t(m.label) }))}
            onChange={setMode}
          />
          {mode === "region" ? (
            <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
          ) : seaZoneError ? (
            <p className="text-footnote text-muted">{t("species.checklists.seaZonesFailed")}</p>
          ) : (
            <div className="space-y-2">
              <SearchInput
                value={zoneSearch}
                onChange={setZoneSearch}
                placeholder={
                  seaZones ? t("species.checklists.searchSeaZones") : t("species.checklists.loadingSeaZones")
                }
                aria-label={t("species.checklists.searchSeaZonesLabel")}
              />
              {zoneMatches.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label={t("species.checklists.matchingSeaZones")}>
                  {zoneMatches.map((z) => (
                    <li key={z.id} className="min-w-0 max-w-full">
                      <Pill size="sm" active={zoneId === z.id} onClick={() => setZoneId(z.id)} className="max-w-full">
                        <span className="truncate">{z.name}</span>
                      </Pill>
                    </li>
                  ))}
                </ul>
              )}
              {seaZones && zoneSearch.trim() && zoneMatches.length === 0 && (
                <p className="text-footnote text-muted">
                  {t("species.checklists.noSeaZoneMatch", { query: zoneSearch.trim() })}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="min-w-0 max-w-full"
              onClick={() => void add()}
              disabled={!target}
              loading={saving}
            >
              <span className="truncate">
                {target ? t("species.checklists.addTo", { name: target.name }) : t("species.checklists.add")}
              </span>
            </Button>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={onDoneAdding}>
              {t("common.cancel")}
            </Button>
          </div>
          {mode === "region" && pickedRegion && !target && (
            <p className="text-footnote text-muted">
              {t("species.checklists.noChecklist", { region: pickedRegion.name })}
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
