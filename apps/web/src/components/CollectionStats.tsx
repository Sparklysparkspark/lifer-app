import { useEffect, useState } from "react";
import type { CollectionStats } from "@lifer/shared";
import { api } from "../api/client";

const TIER_ORDER: Array<keyof CollectionStats["byTier"]> = ["legendary", "epic", "rare", "uncommon", "common", "unrated"];

export default function CollectionStatsPanel() {
  const [stats, setStats] = useState<CollectionStats | null>(null);

  useEffect(() => {
    api.get<CollectionStats>("/collection/stats").then(setStats);
  }, []);

  if (!stats) return <p className="p-4 text-sm text-stone-500">Loading stats…</p>;

  const maxFamilyCount = Math.max(1, ...stats.byFamily.map((f) => f.count));
  const maxYearCount = Math.max(1, ...stats.byYear.map((y) => y.count));

  return (
    <div className="grid gap-6 rounded-lg border border-stone-200 bg-white p-4 text-sm sm:grid-cols-3">
      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">Total collected</h3>
        <p className="text-3xl font-semibold text-stone-900">{stats.totalCollected}</p>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">By tier</h3>
        <ul className="space-y-1">
          {TIER_ORDER.map((tier) => (
            <li key={tier} className="flex items-center justify-between gap-2">
              <span className="capitalize text-stone-600">{tier}</span>
              <span className="font-medium text-stone-900">{stats.byTier[tier]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">By year</h3>
        {stats.byYear.length === 0 ? (
          <p className="text-stone-400">No dated captures yet.</p>
        ) : (
          <ul className="space-y-1">
            {stats.byYear.map((y) => (
              <li key={y.year} className="flex items-center gap-2">
                <span className="w-10 text-stone-600">{y.year}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full bg-stone-900" style={{ width: `${(y.count / maxYearCount) * 100}%` }} />
                </div>
                <span className="w-6 text-right text-stone-500">{y.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sm:col-span-3">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">By family</h3>
        {stats.byFamily.length === 0 ? (
          <p className="text-stone-400">Nothing collected yet.</p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2">
            {stats.byFamily.map((f) => (
              <li key={f.family} className="flex items-center gap-2">
                <span className="w-32 truncate text-stone-600">{f.family}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100">
                  <div className="h-full bg-stone-900" style={{ width: `${(f.count / maxFamilyCount) * 100}%` }} />
                </div>
                <span className="w-6 text-right text-stone-500">{f.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
