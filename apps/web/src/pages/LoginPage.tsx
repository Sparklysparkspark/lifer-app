import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api, ApiError } from "../api/client";
import { Logo } from "../components/Logo";
import PasswordInput from "../components/PasswordInput";

// Single-user app: no invite codes, no public sign-up, and no path to ever add a second
// account. Before any account exists, this page is a one-time "create your account" setup
// screen; once that one account exists, it's a plain login form for good.
export default function LoginPage() {
  const { user, login, register } = useAuth();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<{ needsSetup: boolean }>("/auth/setup-status").then((res) => setNeedsSetup(res.needsSetup));
  }, []);

  if (user) return <Navigate to="/" replace />;
  if (needsSetup === null) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (needsSetup && password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      if (needsSetup) {
        await register(email, password);
      } else {
        await login(email, password);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-8 shadow-sm">
        <Logo variant="wordmark" className="h-8 w-auto" />
        <p className="text-sm text-muted">
          {needsSetup
            ? "A species-indexed home for your wildlife photography. Create the first account to get started."
            : "A species-indexed home for your wildlife photography."}
        </p>

        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
        <PasswordInput
          placeholder="Password"
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete={needsSetup ? "new-password" : "current-password"}
          className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
        {needsSetup && (
          <PasswordInput
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            required
            minLength={8}
            autoComplete="new-password"
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-accent py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
        >
          {needsSetup ? "Make account" : "Log in"}
        </button>

        {!needsSetup && (
          <Link to="/forgot-password" className="block text-center text-sm text-muted hover:underline">
            Forgot password?
          </Link>
        )}
      </form>
    </div>
  );
}
