import { useEffect, useState } from "react";
import { useApp } from "../app/AppContext";
import { referenceId } from "../media/cache";
import { getMeta, setMeta } from "../store/meta";

export { referenceId };

/** The credit and licence line the desktop shows under a reference photo, kept for offline. Null when none or not known yet. */
export function useReferenceCredit(scientificName: string, on: boolean): string | null {
  const { db, api } = useApp();
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return setLine(null);
    let alive = true;
    const slug = referenceId(scientificName).slice(4);
    const key = `refcredit.${slug}`;
    void (async () => {
      const kept = await getMeta<string>(db, key);
      if (kept && alive) setLine(kept);
      if (kept || !api) return;
      try {
        const r = await api.get<{ credit: string | null; license: string | null }>(`/companion/v1/reference/${slug}`);
        const text = [r.credit, r.license].filter(Boolean).join(", ");
        if (text) {
          await setMeta(db, key, text);
          if (alive) setLine(text);
        }
      } catch {
        // No reference photo on the hub, or not reachable: no credit line.
      }
    })();
    return () => {
      alive = false;
    };
  }, [db, api, scientificName, on]);
  return line;
}
