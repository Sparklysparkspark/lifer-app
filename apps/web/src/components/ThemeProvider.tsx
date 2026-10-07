import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThemeContext, type Theme, type ThemePreference } from "../hooks/useTheme";
import { tauriInvoke } from "../lib/tauri";

const STORAGE_KEY = "lifer-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): Theme {
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

function subscribeSystemTheme(onChange: () => void): () => void {
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function initialPreference(): ThemePreference {
  let stored: string | null;
  // Storage can throw (private mode, blocked site data); fall back to the default theme.
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(initialPreference);
  // Read live rather than copied into state, so "system" follows the OS as it changes.
  const system = useSyncExternalStore(subscribeSystemTheme, systemTheme);
  const theme = preference === "system" ? system : preference;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Not persisted this session; the theme still applies.
    }
  }, [preference]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // The desktop window background shows during macOS overscroll, so keep it matching the theme.
    tauriInvoke()?.("set_window_theme_background", { dark: theme === "dark" })?.catch(() => {});
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
}
