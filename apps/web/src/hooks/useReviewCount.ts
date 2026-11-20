import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api/client";

let cached = 0;
const listeners = new Set<(count: number) => void>();

/** Re-reads the count now, for after the review queue confirms or refiles photos. */
export function refreshReviewCount(): void {
  api
    .get("/identifications/suggested/count")
    .then((r) => {
      cached = r.count;
      listeners.forEach((l) => l(cached));
    })
    .catch(() => {
      // Keeps the last count; the next page change tries again.
    });
}

/** Photos Lifer filed by itself and the user hasn't confirmed, for the nav's Review item.
 *  Re-read on every page change and on focus, since imports add to it in the background. */
export function useReviewCount(): number {
  const [count, setCount] = useState(cached);
  const { pathname } = useLocation();
  useEffect(() => {
    listeners.add(setCount);
    window.addEventListener("focus", refreshReviewCount);
    return () => {
      listeners.delete(setCount);
      window.removeEventListener("focus", refreshReviewCount);
    };
  }, []);
  useEffect(refreshReviewCount, [pathname]);
  return count;
}
