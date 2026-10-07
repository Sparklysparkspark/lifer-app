import { createContext, useContext } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
}

// Provided by components/ThemeProvider.tsx.
export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
