import { useOnline } from "./useOnline";
import { usePersistedState } from "./usePersistedState";

export type OnlinePlacesSetting = "auto" | "off";

/** "Online place names and search": Automatic (default) or Off, remembered per browser like the map
 *  setting. `enabled` adds being online; with Off nothing about places ever leaves the device. Callers
 *  show `noticeDue` once (the first online request), then `acknowledge` or `turnOff`. */
export function useOnlinePlaces() {
  const online = useOnline();
  const [setting, setSetting] = usePersistedState<OnlinePlacesSetting>("places-online", "auto");
  const [noted, setNoted] = usePersistedState("places-online-noted", false);
  return {
    setting,
    setSetting,
    enabled: setting === "auto" && online,
    online,
    noticeDue: setting === "auto" && !noted,
    acknowledge: () => setNoted(true),
    turnOff: () => {
      setSetting("off");
      setNoted(true);
    },
  };
}
