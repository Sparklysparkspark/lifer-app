import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api/client";
import { AuthContext, type AuthUser } from "../hooks/useAuth";
import { resetAccountCaches } from "../lib/resource";
import { tauriInvoke } from "../lib/tauri";
import OfflineCacheSync from "./OfflineCacheSync";
import { ignore } from "../lib/ignore";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/auth/me")
      .then((res) => setUser(res.user))
      // Unreachable or signed out both land on the login screen.
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const res = await api.post("/auth/login", { email, password });
    resetAccountCaches();
    setUser(res);
  }

  async function register(email: string, password: string) {
    const res = await api.post("/auth/register", { email, password });
    resetAccountCaches();
    setUser(res);
  }

  async function logout() {
    // The desktop app's offline copy of this account's collection goes with the session.
    await tauriInvoke()?.("offline_cache_clear").catch(ignore("Couldn't clear the offline copy"));
    await api.post("/auth/logout");
    // The next account on this browser shouldn't see a stale copy.
    resetAccountCaches();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      <OfflineCacheSync userId={user?.id ?? null} />
      {children}
    </AuthContext.Provider>
  );
}
