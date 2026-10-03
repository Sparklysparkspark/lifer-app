import { usePersistedState } from "./usePersistedState";

// One shared key so toggling labels on one photo grid (Trip, Album, Trash, a share link)
// carries over to every other one.
export function useShowLabels(): [boolean, (value: boolean) => void] {
  const [saved, setSaved] = usePersistedState<boolean>("showPhotoLabels", true);
  return [saved !== false, setSaved];
}
