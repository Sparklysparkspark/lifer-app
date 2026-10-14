import { useEffect, useState } from "react";
import { describeSeason, describeTier, TIER_ORDER, type TierExplain, type TierReason } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { tierLabel } from "../lib/speciesGroups";
import { iucnBadge, iucnCategoryName } from "../lib/iucnDisplay";
import Modal from "./Modal";
import Button from "./Button";
import Select from "./Select";
import FormMessage from "./FormMessage";

interface TierSide {
  tier: string | null;
  reason: TierReason | null;
  explain: TierExplain | null;
  regionName?: string | null;
}
interface TierDetails {
  iucnStatus?: string | null;
  global: TierSide;
  local: TierSide | null;
  override: { tier: string; everywhere: boolean } | null;
}

// Why a species has its tier here and worldwide, plus the user's own tier. Tiers come from where
// people happened to record the species, so explaining them lets users judge; their own tier wins.
export default function TierDetailsModal({
  speciesId,
  speciesName,
  regionId,
  onClose,
  onChanged,
}: {
  speciesId: string;
  speciesName: string;
  regionId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [details, setDetails] = useState<TierDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [everywhere, setEverywhere] = useState(!regionId);

  useEffect(() => {
    let cancelled = false;
    api
      .get<TierDetails>(`/species/${speciesId}/tier${regionId ? `?regionId=${regionId}` : ""}`)
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setChoice(d.override?.tier ?? "");
        if (d.override) setEverywhere(d.override.everywhere);
      })
      .catch((err) => !cancelled && setError(errorMessage(err, "Couldn't load this tier")));
    return () => {
      cancelled = true;
    };
  }, [speciesId, regionId]);

  async function save(tier: string | null) {
    setSaving(true);
    setError(null);
    try {
      // Clearing removes the override wherever it was set.
      const target = tier === null ? (details?.override?.everywhere ? null : regionId) : everywhere ? null : regionId;
      await api.put(apiPath("/species/{id}/tier-override", { id: speciesId }), { regionId: target, tier });
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save your tier"));
    } finally {
      setSaving(false);
    }
  }

  const local = details?.local ?? null;
  const place = local ? (local.regionName ?? null) : null;
  // Not Evaluated stays on the species page; this explains tiers, and NE adds nothing to that.
  const iucn = iucnBadge(details?.iucnStatus);
  // The full reasoning, folded away under the short facts.
  const why = details
    ? [
        ...(local ? describeTier(local.explain, local.reason, place) : []),
        ...(details.global.tier || !local ? describeTier(details.global.explain, details.global.reason, null) : []),
        ...(iucn && iucn.code !== "NE"
          ? [
              "IUCN status is about how threatened a species is, not how hard it is to find, so it doesn't change the tier.",
            ]
          : []),
      ]
    : [];

  return (
    <Modal open onClose={onClose} title={speciesName} size="sm">
      <FormMessage error={error} />
      {!details ? (
        !error && <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="space-y-1.5">
            {local && <TierRow label="Here" text={sideText(local, place)} />}
            {(details.global.tier || !local) && <TierRow label="Worldwide" text={sideText(details.global, null)} />}
            {iucn && iucn.code !== "NE" && <TierRow label="IUCN" text={iucnCategoryName(iucn.code)} />}
          </div>
          {why.length > 0 && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer hover:text-ink">How Lifer rates this</summary>
              <ul className="mt-1 space-y-0.5">
                {why.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="border-t border-line pt-3">
            <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3">
              <label htmlFor="own-tier" className="text-muted">
                Your tier
              </label>
              <div className="flex items-center gap-2">
                <Select id="own-tier" value={choice} onChange={(e) => setChoice(e.target.value)} className="flex-1">
                  <option value="">Lifer's tier</option>
                  {TIER_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {tierLabel(t)}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={saving}
                  disabled={choice === (details.override?.tier ?? "")}
                  onClick={() => void save(choice || null)}
                >
                  Save
                </Button>
              </div>
            </div>
            <div className="mt-1.5 space-y-1 pl-[calc(6rem+0.75rem)] text-xs text-muted">
              <p>Replaces Lifer's tier on this device.</p>
              {regionId && choice && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={everywhere}
                    onChange={(e) => setEverywhere(e.target.checked)}
                    className="accent-accent"
                  />
                  Everywhere, not just {place ?? "here"}
                </label>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TierRow({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted">{label}</span>
      <span className="text-ink">{text}</span>
    </div>
  );
}

// Long official names read badly mid-line.
const SHORT_PLACE: Record<string, string> = { "United States of America": "the United States" };

/** "Occasional in British Columbia · mostly Sep to Jun": the tier, then the few facts worth a glance. */
function sideText(side: TierSide, place: string | null): string {
  if (!side.tier || side.reason === "thin_data" || side.reason === "no_data") return "Not rated yet";
  const facts = [`${tierLabel(side.tier)}${place ? ` in ${place}` : ""}`];
  if (side.reason === "vagrant") facts.push("rare visitor");
  if (!place && side.explain?.easiestIn)
    facts.push(`easiest to find in ${SHORT_PLACE[side.explain.easiestIn] ?? side.explain.easiestIn}`);
  const season = side.explain ? describeSeason(side.explain.season) : null;
  if (season) facts.push(season.charAt(0).toLowerCase() + season.slice(1));
  return facts.join(" · ");
}
