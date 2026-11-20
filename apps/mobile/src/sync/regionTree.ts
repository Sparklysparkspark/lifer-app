// The hub's region tree (GET /sync/region-tree): every region with a species list there and its
// ancestors, kept as one small document for the Collection's region picker.
import type { Db } from "../store/db";
import { getMeta, setMeta } from "../store/meta";
import type { SyncApi } from "./engine";

export interface TreeNode {
  id: string;
  name: string;
  parentId: string | null;
  /** World 0, continent 1, country 2, then a country's groups and provinces. */
  depth: number;
  /** The region's own species list on the hub; 0 for a group or continent with none. */
  speciesCount: number;
}

const KEY = "regionTree";

export async function pullRegionTree(d: { db: Db; api: SyncApi }): Promise<void> {
  const res = await d.api.get<{ regions?: TreeNode[] }>("/sync/region-tree", 60_000);
  await setMeta(d.db, KEY, res.regions ?? []);
}

export const getRegionTree = async (db: Db): Promise<TreeNode[]> => (await getMeta<TreeNode[]>(db, KEY)) ?? [];
