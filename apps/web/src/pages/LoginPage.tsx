import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../api/client";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { Logo } from "../components/Logo";
import PasswordInput from "../components/PasswordInput";
import { errorMessage } from "../lib/errorMessage";
import { openLocalLibrary } from "../lib/desktopConnection";

// Single-user app: a one-time "create your account" screen until the account exists, then a
// plain login form for good.
export default function LoginPage() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A fresh account goes to onboarding, not through the signed-in redirect to "/" below.
  const [justRegistered, setJustRegistered] = useState(false);
  // In the desktop app connected to a server, signing out lands here, so this is the way back to
  // the library on this computer (Settings, where the switch otherwise lives, needs a sign-in).
  const [connectedServer, setConnectedServer] = useState<string | null>(null);
  const [switchingToLocal, setSwitchingToLocal] = useState(false);

  useEffect(() => {
    window.liferSetup
      ?.getConfig()
      .then((config) => {
        if (config?.mode === "remote") setConnectedServer(config.serverUrl ?? config.localUrl ?? window.location.origin);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<{ needsSetup: boolean }>("/auth/setup-status")
      .then((res) => setNeedsSetup(res.needsSetup))
      .catch((err) => {
        // Fall back to the login form so the page isn't blank; a real attempt reports the problem.
        setNeedsSetup(false);
        setError(errorMessage(err, "Couldn't reach the server"));
      });
  }, []);

  if (user && !justRegistered) return <Navigate to="/" replace />;
  if (needsSetup === null) return null;

  async function switchToLocal() {
    setError(null);
    setSwitchingToLocal(true);
    // On success the desktop shell reloads onto the local library, so this page goes away.
    const failure = await openLocalLibrary();
    if (failure) setError(failure);
    setSwitchingToLocal(false);
  }

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
        setJustRegistered(true);
        await register(email, password);
        navigate("/onboarding", { replace: true });
      } else {
        await login(email, password);
      }
    } catch (err) {
      setJustRegistered(false);
      setError(errorMessage(err, "Something went wrong"));
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

        <FormMessage error={error} />

        <Button type="submit" loading={submitting} className="w-full">
          {needsSetup ? "Make account" : "Log in"}
        </Button>

        {!needsSetup && (
          <Link to="/forgot-password" className="block text-center text-sm text-muted hover:underline">
            Forgot password?
          </Link>
        )}

        {connectedServer && (
          <div className="border-t border-line pt-4 text-center text-sm text-muted">
            <p>Connected to {connectedServer}.</p>
            <button type="button" onClick={switchToLocal} disabled={switchingToLocal} className="mt-1 text-ink hover:underline disabled:opacity-50">
              {switchingToLocal ? "Switching…" : "Use the library on this computer instead"}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
