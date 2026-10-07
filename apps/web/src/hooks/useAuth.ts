import { createContext, useContext } from "react";

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

// Provided by components/AuthProvider.tsx. Kept apart from the provider so this file exports no
// component and fast refresh can hot-swap the provider.
export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
