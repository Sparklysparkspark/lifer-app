import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button, { buttonClasses } from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import PasswordInput from "../../components/PasswordInput";
import { errorMessage } from "../../lib/errorMessage";
import { Card, inputClass } from "./shared";

interface AccountInfo {
  email: string;
}

// Every change here requires the current password (see auth/routes.ts), so a stolen session
// cookie alone can't take over the account. Server mode only: desktop's user has no password.
export default function AccountSettings() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    api
      .get<AccountInfo>("/auth/settings")
      .then(setAccount)
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load your account details")));
  }
  useEffect(load, []);

  if (loadError) {
    return (
      <div className="space-y-2">
        <FormMessage error={loadError} />
        <Button variant="secondary" size="sm" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }
  if (!account) return <InlineSpinner size="sm" label="Loading account" />;

  return (
    <>
      <EmailSection currentEmail={account.email} onChanged={(email) => setAccount({ ...account, email })} />
      <PasswordSection />
      <ApiKeysSection />
    </>
  );
}

function ApiKeysSection() {
  return (
    <Card
      title="API keys"
      description="Personal access tokens for your own scripts and integrations to use, scoped to exactly what they need."
      learnMore="api-keys"
    >
      <Link to="/settings/api-keys" className={buttonClasses("secondary", "sm", "w-fit")}>
        Manage API keys
      </Link>
    </Card>
  );
}

function EmailSection({ currentEmail, onChanged }: { currentEmail: string; onChanged: (email: string) => void }) {
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const res = await api.put<{ email: string }>("/auth/email", { currentPassword, newEmail });
      onChanged(res.email);
      setNewEmail("");
      setCurrentPassword("");
      setSuccess("Email updated.");
    } catch (err) {
      setError(errorMessage(err, "Couldn't update email"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Email" description={`Currently signed in as ${currentEmail}.`} learnMore="email">
      <form onSubmit={handleSubmit} className="space-y-3">
        <input type="email" placeholder="New email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required className={inputClass} />
        <PasswordInput
          placeholder="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
          autoComplete="current-password"
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <Button type="submit" loading={submitting}>
          Update email
        </Button>
      </form>
    </Card>
  );
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    setSubmitting(true);
    try {
      await api.put("/auth/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess("Password updated.");
    } catch (err) {
      setError(errorMessage(err, "Couldn't update password"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Password" description="Change your account password." learnMore="password">
      <form onSubmit={handleSubmit} className="space-y-3">
        <PasswordInput
          placeholder="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
          autoComplete="current-password"
          className={inputClass}
        />
        <PasswordInput
          placeholder="New password"
          value={newPassword}
          onChange={setNewPassword}
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
        <PasswordInput
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <Button type="submit" loading={submitting}>
          Update password
        </Button>
      </form>
    </Card>
  );
}
