import { createContext, useContext } from "react";
import { useColorScheme } from "react-native";
import { palettes, type Appearance, type Palette } from "./theme";

/** The person's choice in Settings; "system" follows the phone's light and dark. */
export type AppearancePref = Appearance | "system";
export const AppearanceContext = createContext<AppearancePref>("system");

export function useTheme(override?: Appearance): { appearance: Appearance; colors: Palette } {
  const system = useColorScheme();
  const pref = useContext(AppearanceContext);
  const appearance = override ?? (pref !== "system" ? pref : system === "dark" ? "dark" : "light");
  return { appearance, colors: palettes[appearance] };
}
