import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import PasswordInput from "../../components/PasswordInput";
import { errorMessage } from "../../lib/errorMessage";
import { SettingRow, SettingsGroup, inputClass } from "./shared";

interface AccountInfo {
  email: string;
}

// Every change here requires the current password (see auth/routes.ts), so a stolen session
// cookie alone can't take over the account. Server mode only: desktop's user has no password.
export default function AccountSettings() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function fetchAccount() {
    api
      .get("/auth/settings")
      .then(setAccount)
      .catch((err) => setLoadError(errorMessage(err, "Couldn't load your account details")));
  }
  // There's no error to clear on the first load, only on Retry.
  useEffect(fetchAccount, []);
  function retry() {
    setLoadError(null);
    fetchAccount();
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <FormMessage error={loadError} />
        <Button variant="secondary" size="sm" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }
  if (!account) return <InlineSpinner size="sm" label="Loading account" />;

  return (
    <>
      <SettingsGroup title="Sign-in">
        <EmailRow currentEmail={account.email} onChanged={(email) => setAccount({ ...account, email })} />
        <PasswordRow />
      </SettingsGroup>
      <SettingsGroup title="Scripts and integrations">
        <SettingRow
          label="API keys"
          description="Tokens for your own scripts, each limited to what it needs."
          control={
            <Link to="/settings/api-keys" className="text-sm text-ink underline">
              Manage API keys
            </Link>
          }
        />
      </SettingsGroup>
    </>
  );
}

function EmailRow({ currentEmail, onChanged }: { currentEmail: string; onChanged: (email: string) => void }) {
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
      const res = await api.put("/auth/email", { currentPassword, newEmail });
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
    <SettingRow label="Email" description={`Signed in as ${currentEmail}.`}>
      <form onSubmit={handleSubmit} className="max-w-sm space-y-2">
        <input
          type="email"
          placeholder="New email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
          className={inputClass}
        />
        <PasswordInput
          placeholder="Current password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
          autoComplete="current-password"
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <Button type="submit" variant="secondary" size="sm" loading={submitting}>
          Update email
        </Button>
      </form>
    </SettingRow>
  );
}

function PasswordRow() {
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
    <SettingRow label="Password">
      <form onSubmit={handleSubmit} className="max-w-sm space-y-2">
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
        <Button type="submit" variant="secondary" size="sm" loading={submitting}>
          Update password
        </Button>
      </form>
    </SettingRow>
  );
}
