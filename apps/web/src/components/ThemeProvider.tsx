import { useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThemeContext, type Theme, type ThemePreference } from "../hooks/useTheme";
import { tauriInvoke } from "../lib/tauri";
import { withThemeTransition } from "../lib/themeFade";
import { ignore } from "../lib/ignore";

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
  // Storage can throw (private mode, blocked site data); fall back to following the system.
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceNow] = useState<ThemePreference>(initialPreference);
  const setPreference = (next: ThemePreference) => withThemeTransition(() => setPreferenceNow(next));
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

  useLayoutEffect(() => {
    document.documentElement.classList.toggle(
      "dark",
      theme === "dark" || document.documentElement.hasAttribute("data-dark-chrome"),
    );
    // The desktop window background shows during macOS overscroll, so keep it matching the theme.
    tauriInvoke()?.("set_window_theme_background", { dark: theme === "dark" })?.catch(
      ignore("Couldn't set the window background"),
    );
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
}
