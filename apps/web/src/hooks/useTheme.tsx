import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
type Preference = Theme | "system";
const STORAGE_KEY = "lifer-theme";

// Same direct window.__TAURI__ access TrafficLights.tsx uses for its own window-chrome
// commands — a no-op outside the desktop app (a plain browser tab/Docker deployment never has
// __TAURI__ at all), so this is safe to call unconditionally.
function tauriInvoke(): ((cmd: string, args?: unknown) => Promise<unknown>) | null {
  const tauri = (window as unknown as { __TAURI__?: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } } }).__TAURI__;
  return tauri?.core.invoke ?? null;
}

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function initialPreference(): Preference {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "light";
}

const ThemeContext = createContext<{ theme: Theme; preference: Preference; setPreference: (p: Preference) => void } | null>(
  null,
);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Preference>(initialPreference);
  const [theme, setTheme] = useState<Theme>(() => (preference === "system" ? systemTheme() : preference));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference);
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
    // Keeps the desktop window's own background in sync with the theme — that's what shows
    // through during macOS's rubber-band overscroll past the top/bottom of the page, and is
    // otherwise stuck at whatever color the window was created with (see lib.rs's own
    // set_window_theme_background comment).
    tauriInvoke()?.("set_window_theme_background", { dark: theme === "dark" });
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
