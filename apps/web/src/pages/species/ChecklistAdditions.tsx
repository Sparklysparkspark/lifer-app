import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../../components/Button";
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
  { value: "region", label: "Country or province" },
  { value: "seaZone", label: "Sea zone" },
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
  return (
    <li className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-dashed border-accent py-0.5 pl-2 pr-1 text-ink">
      {to ? (
        <Link to={to} className="truncate hover:underline">
          {target.name}
        </Link>
      ) : (
        <span className="truncate">{target.name}</span>
      )}
      {target.kind === "seaZone" && <span className="shrink-0 text-muted">(sea)</span>}
      {alsoListed && (
        <span className="shrink-0 text-muted" title="The catalog lists it there too">
          (also listed)
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove from ${checklistLabel(target)}`}
        title={`Remove from ${checklistLabel(target)}`}
        className="shrink-0 rounded px-1 leading-none text-muted hover:bg-surface-muted hover:text-ink disabled:opacity-50"
      >
        ×
      </button>
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
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Added by you to:</span>
          <ul className="flex min-w-0 flex-wrap items-center gap-2" aria-label="Checklists you added this species to">
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
        <div
          className="space-y-3 rounded-lg border border-line bg-surface p-3 text-sm"
          role="group"
          aria-label="Add to another checklist"
        >
          <p className="text-xs text-muted">
            Pick a country, a province or state, or a sea zone, to put {speciesName} on its checklist. It shows there
            marked "Added by you".
          </p>
          <SegmentedControl value={mode} options={PICKER_MODES} onChange={setMode} />
          {mode === "region" ? (
            <RegionBrowser regionId={regionId} onChange={setRegionId} allowAnyRegion />
          ) : seaZoneError ? (
            <p className="text-xs text-muted">Couldn't load the sea zones. Close this and try again.</p>
          ) : (
            <div className="space-y-2">
              <SearchInput
                value={zoneSearch}
                onChange={setZoneSearch}
                placeholder={seaZones ? "Search sea zones…" : "Loading sea zones…"}
                aria-label="Search sea zones"
              />
              {zoneMatches.length > 0 && (
                <ul className="flex flex-wrap gap-2" aria-label="Matching sea zones">
                  {zoneMatches.map((z) => (
                    <li key={z.id} className="min-w-0 max-w-full">
                      <button
                        type="button"
                        onClick={() => setZoneId(z.id)}
                        aria-pressed={zoneId === z.id}
                        className={`max-w-full truncate rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                          zoneId === z.id
                            ? "border-accent bg-accent text-accent-fg"
                            : "border-line bg-surface-muted text-ink hover:border-accent"
                        }`}
                      >
                        {z.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {seaZones && zoneSearch.trim() && zoneMatches.length === 0 && (
                <p className="text-xs text-muted">No sea zone matches "{zoneSearch.trim()}".</p>
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
              <span className="truncate">{target ? `Add to ${target.name}` : "Add"}</span>
            </Button>
            <Button variant="secondary" size="sm" className="shrink-0" onClick={onDoneAdding}>
              Cancel
            </Button>
          </div>
          {mode === "region" && pickedRegion && !target && (
            <p className="text-xs text-muted">
              {pickedRegion.name} has no checklist of its own. Pick a country or a region inside one.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
