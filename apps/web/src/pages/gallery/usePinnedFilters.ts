import { useCallback, useEffect, useState } from "react";
import { api, type ApiResponse } from "../../api/client";
import { ignore } from "../../lib/ignore";
import type { SmartAlbumRules } from "./smartAlbumRules";

export type PinnedFilter = ApiResponse<"/pinned-filters">["pins"][number];
export const MAX_PINS = 50;

/** The account's pinned Gallery filters, saved as a whole list on every change. */
export function usePinnedFilters() {
  const [pins, setPins] = useState<readonly PinnedFilter[]>([]);

  useEffect(() => {
    api
      .get("/pinned-filters")
      .then((res) => setPins(res.pins))
      .catch(ignore("Couldn't load pinned filters"));
  }, []);

  // Throws when the save fails, so the caller can say so; the list stays as it was.
  const save = useCallback(async (next: readonly PinnedFilter[]) => {
    const res = await api.put("/pinned-filters", { pins: next.map(({ id, name, rules }) => ({ id, name, rules })) });
    setPins(res.pins);
  }, []);

  const add = (name: string, rules: SmartAlbumRules) =>
    save([...pins, { id: crypto.randomUUID(), name, rules } as PinnedFilter]);

  return { pins, save, add };
}
