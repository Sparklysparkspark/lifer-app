import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { api } from "../api/client";
import Button from "../components/Button";
import Panel from "../components/Panel";
import FormMessage from "../components/FormMessage";
import { Logo } from "../components/Logo";
import PasswordInput from "../components/PasswordInput";
import { errorMessage } from "../lib/errorMessage";
import { openLocalLibrary } from "../lib/desktopConnection";
import { ignore } from "../lib/ignore";
import TextField from "../components/TextField";

// Single-user app: a one-time "create your account" screen until the account exists, then a
// plain login form for good.
export default function LoginPage() {
  const { t } = useTranslation();
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
        if (config?.mode === "remote")
          setConnectedServer(config.serverUrl ?? config.localUrl ?? window.location.origin);
      })
      .catch(ignore("Couldn't read the desktop connection"));
  }, []);

  useEffect(() => {
    api
      .get<{ needsSetup: boolean }>("/auth/setup-status")
      .then((res) => setNeedsSetup(res.needsSetup))
      .catch((err) => {
        // Fall back to the login form so the page isn't blank; a real attempt reports the problem.
        setNeedsSetup(false);
        setError(errorMessage(err, t("auth.login.unreachable")));
      });
  }, [t]);

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
      setError(t("auth.login.passwordMismatch"));
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
      setError(errorMessage(err, t("auth.login.failed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <Panel as="form" onSubmit={handleSubmit} className="w-full max-w-sm space-y-4">
        <Logo variant="wordmark" className="h-8 w-auto" />
        <p className="text-callout text-muted">{needsSetup ? t("auth.login.taglineSetup") : t("auth.login.tagline")}</p>

        <TextField
          type="email"
          placeholder={t("auth.login.email")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <PasswordInput
          placeholder={t("auth.login.password")}
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          autoComplete={needsSetup ? "new-password" : "current-password"}
        />
        {needsSetup && (
          <PasswordInput
            placeholder={t("auth.login.confirmPassword")}
            value={confirmPassword}
            onChange={setConfirmPassword}
            required
            minLength={8}
            autoComplete="new-password"
          />
        )}

        <FormMessage error={error} />

        <Button type="submit" loading={submitting} className="w-full">
          {needsSetup ? t("auth.login.makeAccount") : t("auth.login.logIn")}
        </Button>

        {!needsSetup && (
          <Link to="/forgot-password" className="block text-center text-callout text-muted hover:underline">
            {t("auth.login.forgot")}
          </Link>
        )}

        {connectedServer && (
          <div className="border-t border-line pt-4 text-center text-callout text-muted">
            <p>{t("auth.login.connectedTo", { server: connectedServer })}</p>
            <Button variant="link" onClick={switchToLocal} disabled={switchingToLocal} className="mt-1 text-ink">
              {switchingToLocal ? t("auth.login.switching") : t("auth.login.useLocal")}
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
