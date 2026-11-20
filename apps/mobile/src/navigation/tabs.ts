import type { IconName } from "../ui/Icon";
import type { TabName } from "./types";

// The four tabs (Trips lives inside Albums), in order (plan: Information architecture). Stats, Regions and Settings open from the
// account button; Home is gone.
export const TABS: { name: TabName; label: string; icon: IconName }[] = [
  { name: "Collection", label: "tabs.collection", icon: "collection" },
  { name: "Gallery", label: "tabs.gallery", icon: "gallery" },
  { name: "Albums", label: "tabs.albums", icon: "albums" },
  { name: "Identify", label: "tabs.identify", icon: "identify" },
];
