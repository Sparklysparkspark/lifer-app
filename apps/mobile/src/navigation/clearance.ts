import { createContext, useContext } from "react";

/** How much of the bottom of a tab screen the tab bar (and the trip bar above it) covers, for pieces we pin ourselves. */
export const TabClearanceContext = createContext(0);
export const useTabClearance = (): number => useContext(TabClearanceContext);

/** The floating iOS 26 tab bar and the gap under it. */
export const TAB_BAR = 92;
/** The trip bar above the tab bar. */
export const TRIP_BAR = 62;
