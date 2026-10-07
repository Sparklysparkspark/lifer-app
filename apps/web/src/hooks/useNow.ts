import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs`, for render logic that compares against "now"
 *  (reading the clock during render would give a different answer each time React renders). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
