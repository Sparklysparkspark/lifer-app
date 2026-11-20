import { useEffect, useState } from "react";
import { formatNumber } from "../lib/format";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { backStateFor } from "../lib/backLabel";
import type { CollectionStats } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import FormMessage from "./FormMessage";
import Select from "./Select";
import Panel from "./Panel";

const TIER_ORDER: Array<keyof CollectionStats["byTier"]> = [
  "legendary",
  "rare",
  "uncommon",
  "occasional",
  "common",
  "unrated",
];

const TIER_KEYS: Record<keyof CollectionStats["byTier"], string> = {
  legendary: "collection.tiers.legendary",
  rare: "collection.tiers.rare",
  uncommon: "collection.tiers.uncommon",
  occasional: "collection.tiers.occasional",
  common: "collection.tiers.common",
  unrated: "collection.tiers.unrated",
};

export default function CollectionStatsPanel() {
  const location = useLocation();
  const { t } = useTranslation();
  const [stats, setStats] = useState<CollectionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "" counts each species' overall tier; a region counts its local tier there, among the species
  // you've photographed in it.
  const [tierRegionId, setTierRegionId] = useState("");

  useEffect(() => {
    api
      .get(apiPath("/collection/stats", {}, { regionId: tierRegionId ?? undefined }))
      .then(setStats)
      .catch((err) => setError(errorMessage(err, t("collectionStats.loadFailed"))));
  }, [tierRegionId, t]);

  if (error) return <FormMessage error={error} className="m-4" />;
  if (!stats) return <p className="p-4 text-callout text-muted">{t("collectionStats.loading")}</p>;

  const maxYearCount = Math.max(1, ...stats.byYear.map((y) => y.count));

  return (
    <Panel className="grid gap-item text-callout sm:grid-cols-3">
      <div>
        <h3 className="mb-2 text-footnote font-medium text-muted">{t("collectionStats.total")}</h3>
        <p className="text-large-title font-semibold text-ink">{formatNumber(stats.totalCollected)}</p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-footnote font-medium text-muted">{t("collectionStats.byRarity")}</h3>
          {stats.tierRegions.length > 0 && (
            <Select
              aria-label={t("collectionStats.rarityFor")}
              value={tierRegionId}
              onChange={(e) => setTierRegionId(e.target.value)}
              className="max-w-40 text-footnote"
            >
              <option value="">{t("collectionStats.overall")}</option>
              {stats.tierRegions.map((r) => (
                <option key={r.id} value={r.id}>
                  {t("commandPalette.inRegion", { region: r.name })}
                </option>
              ))}
            </Select>
          )}
        </div>
        <ul className="space-y-1">
          {TIER_ORDER.map((tier) => (
            <li key={tier}>
              {/* Opens the Gallery on that tier's photos. */}
              {stats.byTier[tier] > 0 ? (
                <Link
                  to={
                    tierRegionId
                      ? `/gallery?tier=${tier}&tierRegionId=${tierRegionId}&regionId=${tierRegionId}`
                      : `/gallery?tier=${tier}`
                  }
                  state={backStateFor(location, t)}
                  className="-mx-1 flex items-center justify-between gap-2 rounded-control px-1 hover:bg-surface-muted"
                >
                  <span className="capitalize text-muted">{t(TIER_KEYS[tier])}</span>
                  <span className="font-medium text-ink">{formatNumber(stats.byTier[tier])}</span>
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="capitalize text-muted">{t(TIER_KEYS[tier])}</span>
                  <span className="font-medium text-ink">{formatNumber(stats.byTier[tier])}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-footnote font-medium text-muted">{t("collectionStats.byYear")}</h3>
        {stats.byYear.length === 0 ? (
          <p className="text-muted">{t("collectionStats.noDated")}</p>
        ) : (
          <ul className="space-y-1">
            {stats.byYear.map((y) => (
              <li key={y.year} className="flex items-center gap-2">
                <span className="w-10 text-muted">{y.year}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
                  <div className="h-full bg-ink" style={{ width: `${(y.count / maxYearCount) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-muted">{formatNumber(y.count)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
