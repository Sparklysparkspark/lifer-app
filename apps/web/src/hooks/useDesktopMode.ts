import { useEffect, useState } from "react";
import { api } from "../api/client";

// There's no dedicated "am I desktop mode" flag from the backend; /settings/storage already
// only exists (200) in SINGLE_USER_MODE and 404s otherwise (see settings/routes.ts's
// requireDesktopMode), so its presence doubles as the signal here rather than adding a
// second endpoint that would just answer the same question.
export function useDesktopMode(): boolean {
  const [isDesktopMode, setIsDesktopMode] = useState(false);

  useEffect(() => {
    api
      .get("/settings/storage")
      .then(() => setIsDesktopMode(true))
      .catch(() => setIsDesktopMode(false));
  }, []);

  return isDesktopMode;
}
