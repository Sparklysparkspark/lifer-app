import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TIER_ORDER, type TierExplain, type TierReason } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { describeSeason, describeTier } from "../lib/tierDescription";
import { tierLabel } from "../lib/speciesGroups";
import { iucnBadge, iucnCategoryName } from "../lib/iucnDisplay";
import i18n from "../i18n";
import Modal from "./Modal";
import { useToast } from "../hooks/useToast";
import Button from "./Button";
import Select from "./Select";
import FormMessage from "./FormMessage";
import Checkbox from "./Checkbox";

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
  const { t } = useTranslation();
  const toast = useToast();
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
      .catch((err) => !cancelled && setError(errorMessage(err, t("tierDetails.loadFailed"))));
    return () => {
      cancelled = true;
    };
  }, [speciesId, regionId, t]);

  async function save(tier: string | null) {
    setSaving(true);
    setError(null);
    try {
      // Clearing removes the override wherever it was set.
      const target = tier === null ? (details?.override?.everywhere ? null : regionId) : everywhere ? null : regionId;
      await api.put(apiPath("/species/{id}/tier-override", { id: speciesId }), { regionId: target, tier });
      onChanged();
      onClose();
      toast.success(t("tierDetails.saved"));
    } catch (err) {
      setError(errorMessage(err, t("tierDetails.saveFailed")));
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
        ...(iucn && iucn.code !== "NE" ? [t("tierDetails.iucnNote")] : []),
      ]
    : [];

  return (
    <Modal
      open
      onClose={onClose}
      title={speciesName}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.done")}
        </Button>
      }
    >
      <FormMessage error={error} />
      {!details ? (
        !error && <p className="text-callout text-muted">{t("common.loading")}</p>
      ) : (
        <div className="space-y-4 text-callout">
          <div className="space-y-1.5">
            {local && <TierRow label={t("tierDetails.here")} text={sideText(local, place)} />}
            {(details.global.tier || !local) && (
              <TierRow label={t("tierDetails.worldwide")} text={sideText(details.global, null)} />
            )}
            {iucn && iucn.code !== "NE" && <TierRow label={t("tierDetails.iucn")} text={iucnCategoryName(iucn.code)} />}
          </div>
          {why.length > 0 && (
            <details className="text-footnote text-muted">
              <summary className="cursor-pointer hover:text-ink">{t("tierDetails.howRated")}</summary>
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
                {t("tierDetails.yourRarity")}
              </label>
              <div className="flex items-center gap-2">
                <Select id="own-tier" value={choice} onChange={(e) => setChoice(e.target.value)} className="flex-1">
                  <option value="">{t("tierDetails.lifersRarity")}</option>
                  {TIER_ORDER.map((tier) => (
                    <option key={tier} value={tier}>
                      {tierLabel(tier)}
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
                  {t("common.save")}
                </Button>
              </div>
            </div>
            <div className="mt-1.5 space-y-1 pl-[calc(6rem+0.75rem)] text-footnote text-muted">
              <p>{t("tierDetails.replaces")}</p>
              {regionId && choice && (
                <Checkbox checked={everywhere} onChange={setEverywhere}>
                  {place ? t("tierDetails.everywhereNotJust", { place }) : t("tierDetails.everywhereNotJustHere")}
                </Checkbox>
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
  if (!side.tier || side.reason === "thin_data" || side.reason === "no_data") return i18n.t("tierDetails.notRated");
  const facts = [place ? i18n.t("tierDetails.tierIn", { tier: tierLabel(side.tier), place }) : tierLabel(side.tier)];
  if (side.reason === "vagrant") facts.push(i18n.t("tierDetails.rareVisitor"));
  if (!place && side.explain?.easiestIn)
    facts.push(
      i18n.t("tierDetails.easiestIn", { place: SHORT_PLACE[side.explain.easiestIn] ?? side.explain.easiestIn }),
    );
  const season = side.explain ? describeSeason(side.explain.season) : null;
  if (season) facts.push(season.charAt(0).toLowerCase() + season.slice(1));
  return facts.join(" · ");
}
