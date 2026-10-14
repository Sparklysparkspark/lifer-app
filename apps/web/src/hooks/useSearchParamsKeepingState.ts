import { useCallback } from "react";
import { useLocation, useSearchParams, type SetURLSearchParams } from "react-router-dom";

/** useSearchParams whose setter keeps the entry's location state, so a page's back link still
 *  names (and falls back to) the page it was opened from after a search or filter change. */
export function useSearchParamsKeepingState(): [URLSearchParams, SetURLSearchParams] {
  const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useLocation();
  const setKeepingState = useCallback<SetURLSearchParams>(
    (next, options) => setSearchParams(next, { state, ...options }),
    [setSearchParams, state],
  );
  return [searchParams, setKeepingState];
}

/** One query parameter as page state ("" when absent), so Back returns to it. Changes replace the
 *  entry: a view toggle or a search keystroke isn't a page of its own. */
export function useUrlParam(key: string): [string, (value: string) => void] {
  const [searchParams, setSearchParams] = useSearchParamsKeepingState();
  const set = useCallback(
    (value: string) =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          return next;
        },
        { replace: true },
      ),
    [key, setSearchParams],
  );
  return [searchParams.get(key) ?? "", set];
}
