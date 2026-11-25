import { useEffect, useState } from "react";
import { api } from "../api/client";

// Asked once per session: only the API knows it runs in the desktop app on a Mac with Photos.
let cached: Promise<boolean> | null = null;

/** True when "Send keywords to Apple Photos" can run here; false on Windows, Linux and servers. */
export function useApplePhotosAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    cached ??= api
      .get("/apple-photos/status")
      .then((r) => r.available)
      .catch(() => {
        cached = null;
        return false;
      });
    let live = true;
    void cached.then((v) => live && setAvailable(v));
    return () => {
      live = false;
    };
  }, []);
  return available;
}
