import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { backStateFor } from "../lib/backLabel";
import type { CollectionStats } from "@lifer/shared";
import { api } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import FormMessage from "./FormMessage";
import Select from "./Select";
import { PANEL } from "../lib/layout";

const TIER_ORDER: Array<keyof CollectionStats["byTier"]> = [
  "legendary",
  "rare",
  "uncommon",
  "occasional",
  "common",
  "unrated",
];

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
      .get<CollectionStats>(`/collection/stats${tierRegionId ? `?regionId=${tierRegionId}` : ""}`)
      .then(setStats)
      .catch((err) => setError(errorMessage(err, "Couldn't load stats")));
  }, [tierRegionId]);

  if (error) return <FormMessage error={error} className="m-4" />;
  if (!stats) return <p className="p-4 text-sm text-muted">Loading stats…</p>;

  const maxYearCount = Math.max(1, ...stats.byYear.map((y) => y.count));

  return (
    <div className={`grid gap-item text-sm sm:grid-cols-3 ${PANEL}`}>
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted">Total collected</h3>
        <p className="text-3xl font-semibold text-ink">{stats.totalCollected}</p>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted">By tier</h3>
          {stats.tierRegions.length > 0 && (
            <Select
              aria-label="Tiers for"
              value={tierRegionId}
              onChange={(e) => setTierRegionId(e.target.value)}
              className="max-w-40 text-xs"
            >
              <option value="">Overall</option>
              {stats.tierRegions.map((r) => (
                <option key={r.id} value={r.id}>
                  In {r.name}
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
                  <span className="capitalize text-muted">{tier}</span>
                  <span className="font-medium text-ink">{stats.byTier[tier]}</span>
                </Link>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <span className="capitalize text-muted">{tier}</span>
                  <span className="font-medium text-ink">{stats.byTier[tier]}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium text-muted">By year</h3>
        {stats.byYear.length === 0 ? (
          <p className="text-muted">No dated captures yet.</p>
        ) : (
          <ul className="space-y-1">
            {stats.byYear.map((y) => (
              <li key={y.year} className="flex items-center gap-2">
                <span className="w-10 text-muted">{y.year}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-muted">
                  <div className="h-full bg-ink" style={{ width: `${(y.count / maxYearCount) * 100}%` }} />
                </div>
                <span className="w-6 text-right text-muted">{y.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
