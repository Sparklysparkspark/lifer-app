import { useEffect, useState } from "react";
import { describeTier, TIER_ORDER, type TierExplain, type TierReason } from "@lifer/shared";
import { api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { tierLabel } from "../lib/speciesGroups";
import { iucnBadge } from "../lib/iucnDisplay";
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
      await api.put(`/species/${speciesId}/tier-override`, { regionId: target, tier });
      onChanged();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save your tier"));
    } finally {
      setSaving(false);
    }
  }

  const side = details?.local ?? details?.global ?? null;
  const place = details?.local ? (details.local.regionName ?? null) : null;
  // Not Evaluated stays on the species page; this explains tiers, and NE adds nothing to that.
  const iucn = iucnBadge(details?.iucnStatus);
  const lines = side ? describeTier(side.explain, side.reason, place) : [];
  const worldLines =
    details?.local && details.global.tier ? describeTier(details.global.explain, details.global.reason, null) : [];

  return (
    <Modal open onClose={onClose} title={speciesName} size="sm">
      <FormMessage error={error} />
      {!details ? (
        !error && <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <section>
            <h3 className="font-medium text-ink">
              {side?.tier
                ? `${tierLabel(side.tier)}${place ? ` in ${place}` : " worldwide"}`
                : `Not rated${place ? ` in ${place}` : ""}`}
            </h3>
            <ul className="mt-1 space-y-0.5 text-muted">
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
          {worldLines.length > 0 && (
            <section>
              <h3 className="font-medium text-ink">{tierLabel(details.global.tier!)} worldwide</h3>
              <ul className="mt-1 space-y-0.5 text-muted">
                {worldLines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </section>
          )}
          {iucn && iucn.code !== "NE" && (
            <section>
              <h3 className="font-medium text-ink">{iucn.label}</h3>
              <p className="mt-1 text-muted">
                Conservation status, from the IUCN Red List. It's about how threatened the species is, not how hard it
                is to find, so it doesn't change the tier.
              </p>
            </section>
          )}
          <section className="border-t border-line pt-3">
            <h3 className="font-medium text-ink">Your own tier</h3>
            <p className="mt-0.5 text-xs text-muted">
              Wrong for where you look? Your tier replaces Lifer's on this device.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Select value={choice} onChange={(e) => setChoice(e.target.value)} className="flex-1">
                <option value="">Lifer's tier</option>
                {TIER_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {tierLabel(t)}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                loading={saving}
                disabled={choice === (details.override?.tier ?? "")}
                onClick={() => void save(choice || null)}
              >
                Save
              </Button>
            </div>
            {regionId && choice && (
              <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} />
                Use it everywhere, not just {place ?? "here"}
              </label>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
