// A paired phone keeps the hub's installed region packs as its own checklists, with no choosing:
// new ones are fetched, changed ones refreshed, and ones removed on the hub removed here. A province or
// group the person picked in the region picker is kept the same way while the hub still lists it in its tree.
import type { Db } from "../store/db";
import { deleteMeta, getMeta, setMeta } from "../store/meta";
import { listRegions, regionKeyForHub, removeRegion, saveRegion } from "../store/regions";
import type { Preferences, SyncApi } from "./engine";
import type { TreeNode } from "./regionTree";

interface Checklist {
  items: { scientificName: string; commonName: string | null; taxonClass: string; tier: string | null; isVagrant: boolean; sensitiveByDefault: boolean; taxonOrder?: string | null; family?: string | null }[];
  name: string;
}

const sigKey = (key: string) => `regionSig.${key}`;

export async function mirrorRegions(d: { db: Db; api: SyncApi; now: () => Date }, prefs: Preferences, tree: TreeNode[] = []): Promise<void> {
  const want = prefs.regions.filter((r): r is typeof r & { regionId: string } => !!r.regionId);
  const wantIds = new Set(want.map((r) => r.regionId));
  const listed = new Map(tree.filter((n) => n.speciesCount > 0).map((n) => [n.id, n]));
  const kept = await listRegions(d.db);
  // Picked regions: kept here, not an installed pack, still on the hub's tree.
  const picked = kept.flatMap((r) => (r.source === "hub" && r.hubRegionId && !wantIds.has(r.hubRegionId) && listed.has(r.hubRegionId) ? [r.hubRegionId] : []));
  const keepIds = new Set([...wantIds, ...picked]);
  for (const r of kept) {
    if (r.source === "hub" && r.hubRegionId && !keepIds.has(r.hubRegionId)) {
      await removeRegion(d.db, r.key);
      await deleteMeta(d.db, sigKey(r.key));
    }
  }
  const wanted = [...want.map((r) => ({ regionId: r.regionId, sig: `${r.packIds.join(",")}:${r.speciesCount}` })), ...picked.map((id) => ({ regionId: id, sig: `tree:${listed.get(id)!.speciesCount}` }))];
  for (const r of wanted) {
    const key = regionKeyForHub(r.regionId);
    const sig = r.sig;
    const have = (await listRegions(d.db)).some((x) => x.key === key);
    if (have && (await getMeta<string>(d.db, sigKey(key))) === sig) continue;
    try {
      const list = await d.api.get<Checklist>(`/sync/regions/${r.regionId}/checklist`, 60_000);
      await saveRegion(
        d.db,
        { key, name: list.name, source: "hub", hubRegionId: r.regionId },
        list.items.map((i) => ({ scientificName: i.scientificName, commonName: i.commonName, taxonClass: i.taxonClass, tier: i.tier, vagrant: i.isVagrant, sensitive: i.sensitiveByDefault, taxonOrder: i.taxonOrder, family: i.family })),
        d.now(),
      );
      await setMeta(d.db, sigKey(key), sig);
    } catch {
      // Tried again at the next sync; the rest of this one carries on.
    }
  }
}
