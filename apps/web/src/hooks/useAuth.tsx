import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { resetSettingsCache } from "./useSettings";

interface AuthUser {
  id: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<{ user: AuthUser | null }>("/auth/me")
      .then((res) => setUser(res.user))
      // Unreachable or signed out both land on the login screen.
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post<AuthUser>("/auth/login", { email, password });
    resetSettingsCache();
    setUser(res);
  }

  async function register(email: string, password: string) {
    const res = await api.post<AuthUser>("/auth/register", { email, password });
    resetSettingsCache();
    setUser(res);
  }

  async function logout() {
    await api.post("/auth/logout");
    // The next account on this browser shouldn't see a stale copy.
    resetSettingsCache();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
