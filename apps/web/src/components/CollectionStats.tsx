import { useEffect, useState } from "react";
import type { CollectionStats } from "@lifer/shared";
import { api } from "../api/client";

const TIER_ORDER: Array<keyof CollectionStats["byTier"]> = ["legendary", "epic", "rare", "uncommon", "common", "unrated"];

export default function CollectionStatsPanel() {
  const [stats, setStats] = useState<CollectionStats | null>(null);

  useEffect(() => {
    api.get<CollectionStats>("/collection/stats").then(setStats);
  }, []);

  if (!stats) return <p className="p-4 text-sm text-muted">Loading stats…</p>;

  const maxYearCount = Math.max(1, ...stats.byYear.map((y) => y.count));

  return (
    <div className="grid gap-6 rounded-lg border border-line bg-surface p-4 text-sm sm:grid-cols-3">
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Total collected</h3>
        <p className="text-3xl font-semibold text-ink">{stats.totalCollected}</p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">By tier</h3>
        <ul className="space-y-1">
          {TIER_ORDER.map((tier) => (
            <li key={tier} className="flex items-center justify-between gap-2">
              <span className="capitalize text-muted">{tier}</span>
              <span className="font-medium text-ink">{stats.byTier[tier]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">By year</h3>
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
