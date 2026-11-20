import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";

export interface InatStatus {
  available: boolean;
  connected: boolean;
  username: string | null;
}

let cached: InatStatus | null = null;
const listeners = new Set<(status: InatStatus | null) => void>();

async function refresh(): Promise<void> {
  try {
    cached = await api.get("/inaturalist/status");
  } catch {
    cached = null;
  }
  listeners.forEach((l) => l(cached));
}

/** Whether iNaturalist linking exists and is connected, shared by the sidebar, filters and photo
 *  menus. Re-checked on focus, since sign-in finishes in the system browser. Null until known. */
export function useInatStatus(): InatStatus | null {
  const [status, setStatus] = useState<InatStatus | null>(cached);
  useEffect(() => {
    listeners.add(setStatus);
    if (cached === null) void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      listeners.delete(setStatus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return status;
}

/** Re-reads the status now, for after Connect or Disconnect. */
export function useRefreshInatStatus(): () => void {
  return useCallback(() => void refresh(), []);
}
