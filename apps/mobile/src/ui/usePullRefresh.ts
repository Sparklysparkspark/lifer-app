import { useEffect, useState } from "react";

/**
 * The pull-to-refresh spinner shows only for a pull the person made. A background sync that starts by
 * itself must not switch the native refresh control on: iOS leaves its spinner frozen when the screen
 * it sits on is left mid-spin.
 */
export function usePullRefresh(onRefresh: (() => void) | undefined, syncing: boolean) {
  const [pulled, setPulled] = useState(false);
  useEffect(() => {
    if (!syncing) setPulled(false);
  }, [syncing]);
  return {
    onRefresh: onRefresh
      ? () => {
          setPulled(true);
          onRefresh();
        }
      : undefined,
    refreshing: pulled && syncing,
  };
}
