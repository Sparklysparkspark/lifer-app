import { useEffect, useState } from "react";
import { api } from "../api/client";

// There's no dedicated "am I desktop mode" flag from the backend; /settings/storage already
// only exists (200) in SINGLE_USER_MODE and 404s otherwise (see settings/routes.ts's
// requireDesktopMode), so its presence doubles as the signal here rather than adding a
// second endpoint that would just answer the same question.
export function useDesktopMode(): boolean {
  // Seeded from window.liferSetup (set synchronously in main.tsx, before this ever renders)
  // instead of always starting false — a plain `false` default meant every fresh mount of a
  // page using this hook (e.g. navigating back to one) briefly rendered the server-mode
  // "logged in as ..." UI before the async check below caught up, especially visible if that
  // request lagged even a little.
  const [isDesktopMode, setIsDesktopMode] = useState(() => !!window.liferSetup);

  useEffect(() => {
    api
      .get("/settings/storage")
      .then(() => setIsDesktopMode(true))
      .catch(() => setIsDesktopMode(false));
  }, []);

  return isDesktopMode;
}
