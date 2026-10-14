import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

// Real history back, so the page left keeps its URL-held search and filters; the fallback when
// there's no earlier page in this visit. That's React Router's own position in the history
// (`idx`), not `location.key`: a page opened from a pasted URL and then redirected (signing in
// first, say) has a key but nothing of the app's behind it, and going back would leave the app
// for a blank tab.
export function hasEarlierPage(): boolean {
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx > 0;
}

/** Returns to the page this one was opened from, else to `location.state.backTo`, else to
 *  `fallbackTo`. `replace` drops this page from history on that fallback (a picker that's done, a
 *  deleted species). */
export function useGoBack() {
  const navigate = useNavigate();
  const { state } = useLocation();
  const backTo = (state as { backTo?: string } | null)?.backTo;
  return useCallback(
    (fallbackTo: string, options?: { replace?: boolean }) => {
      if (hasEarlierPage()) navigate(-1);
      else navigate(backTo ?? fallbackTo, options);
    },
    [navigate, backTo],
  );
}
