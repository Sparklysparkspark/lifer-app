import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { tauriInvoke } from "../lib/tauri";

type Theme = "light" | "dark";
type Preference = Theme | "system";
const STORAGE_KEY = "lifer-theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialPreference(): Preference {
  let stored: string | null = null;
  // Storage can throw (private mode, blocked site data); fall back to the default theme.
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
}

const ThemeContext = createContext<{ theme: Theme; preference: Preference; setPreference: (p: Preference) => void } | null>(
  null,
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Preference>(initialPreference);
  const [theme, setTheme] = useState<Theme>(() => (preference === "system" ? systemTheme() : preference));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // Not persisted this session; the theme still applies.
    }
    if (preference !== "system") {
      setTheme(preference);
      return;
    }
    setTheme(systemTheme());
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(systemTheme());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    // The desktop window background shows during macOS overscroll, so keep it matching the theme.
    tauriInvoke()?.("set_window_theme_background", { dark: theme === "dark" })?.catch(() => {});
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
