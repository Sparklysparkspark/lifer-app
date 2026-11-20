// Named target lists (apps/api collection/targetLists.ts): general or for one region.
import { useEffect, useState } from "react";
import { api, type ApiResponse } from "../api/client";
import { ignore } from "./ignore";

export type TargetList = ApiResponse<"/target-lists">["lists"][number];

const CHANGED = "lifer:target-lists-changed";
/** Tells every useTargetLists to fetch again after an import, rename or delete. */
export const targetListsChanged = () => window.dispatchEvent(new Event(CHANGED));

/** The user's lists, null until they load. */
export function useTargetLists(): TargetList[] | null {
  const [lists, setLists] = useState<TargetList[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .get("/target-lists")
        .then((res) => live && setLists(res.lists))
        .catch(ignore("Couldn't load target lists"));
    load();
    window.addEventListener(CHANGED, load);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, load);
    };
  }, []);
  return lists;
}

/** Lists for `regionId` first, then the rest, each by name as the API sorts them. */
export const regionListsFirst = (lists: TargetList[], regionId: string | null) =>
  regionId ? [...lists].sort((a, b) => Number(b.regionId === regionId) - Number(a.regionId === regionId)) : lists;
