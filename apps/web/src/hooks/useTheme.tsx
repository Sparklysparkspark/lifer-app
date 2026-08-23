import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
type Preference = Theme | "system";
const STORAGE_KEY = "lifer-theme";

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
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, preference, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
