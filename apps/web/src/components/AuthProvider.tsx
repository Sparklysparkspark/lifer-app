import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import { AuthContext, type AuthUser } from "../hooks/useAuth";
import { resetAccountCaches } from "../lib/resource";
import { tauriInvoke } from "../lib/tauri";
import { ensureDesktopLink, forgetDesktopLink } from "../lib/desktopLink";
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

  // An expired session goes back to the login screen. /auth/me confirms it first, so a stray 401
  // never signs out a live session (and a burst of them asks once).
  useEffect(() => {
    let checking = false;
    setUnauthorizedHandler(() => {
      if (checking) return;
      checking = true;
      api
        .get("/auth/me")
        .catch((err: unknown) => {
          if (!(err instanceof ApiError && err.status === 401)) return;
          resetAccountCaches();
          setUser(null);
        })
        .finally(() => {
          checking = false;
        });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // Connected to a server from the desktop app: give the app its own key for that server, once.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId) return;
    void ensureDesktopLink(tauriInvoke()).catch(ignore("Couldn't link the desktop app to this server"));
  }, [userId]);

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
    await forgetDesktopLink(tauriInvoke());
    await api.post("/auth/logout");
    // The next account on this browser shouldn't see a stale copy.
    resetAccountCaches();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>;
}
