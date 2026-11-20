import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import InlineSpinner from "../../components/InlineSpinner";
import PasswordInput from "../../components/PasswordInput";
import { errorMessage } from "../../lib/errorMessage";
import TextField from "../../components/TextField";
import { SettingLinkRow, SettingRow, SettingsGroup } from "./shared";

interface AccountInfo {
  email: string;
}

// Every change here requires the current password (see auth/routes.ts), so a stolen session
// cookie alone can't take over the account. Server mode only: desktop's user has no password.
export default function AccountSettings() {
  const { t } = useTranslation();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function fetchAccount() {
    api
      .get("/auth/settings")
      .then(setAccount)
      .catch((err) => setLoadError(errorMessage(err, t("settings.account.loadFailed"))));
  }
  // There's no error to clear on the first load, only on Retry.
  useEffect(fetchAccount, [t]);
  function retry() {
    setLoadError(null);
    fetchAccount();
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <FormMessage error={loadError} />
        <Button variant="secondary" size="sm" onClick={retry}>
          {t("settings.retry")}
        </Button>
      </div>
    );
  }
  if (!account) return <InlineSpinner size="sm" label={t("settings.account.loading")} />;

  return (
    <>
      <SettingsGroup title={t("settings.account.signIn")}>
        <EmailRow currentEmail={account.email} onChanged={(email) => setAccount({ ...account, email })} />
        <PasswordRow />
      </SettingsGroup>
      <SettingsGroup title={t("settings.account.scripts")}>
        <SettingLinkRow
          to="/settings/api-keys"
          label={t("settings.account.apiKeys")}
          description={t("settings.account.apiKeysDescription")}
        />
      </SettingsGroup>
    </>
  );
}

function EmailRow({ currentEmail, onChanged }: { currentEmail: string; onChanged: (email: string) => void }) {
  const { t } = useTranslation();
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
      setSuccess(t("settings.account.emailUpdated"));
    } catch (err) {
      setError(errorMessage(err, t("settings.account.emailFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SettingRow
      label={t("settings.account.email")}
      description={t("settings.account.signedInAs", { email: currentEmail })}
    >
      <form onSubmit={handleSubmit} className="max-w-sm space-y-2">
        <TextField
          type="email"
          placeholder={t("settings.account.newEmail")}
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
        />
        <PasswordInput
          placeholder={t("settings.account.currentPassword")}
          value={currentPassword}
          onChange={setCurrentPassword}
          required
          autoComplete="current-password"
        />
        <FormMessage error={error} success={success} />
        <Button size="sm" type="submit" variant="secondary" loading={submitting}>
          {t("settings.account.updateEmail")}
        </Button>
      </form>
    </SettingRow>
  );
}

function PasswordRow() {
  const { t } = useTranslation();
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
      setError(t("settings.account.passwordMismatch"));
      return;
    }
    setSubmitting(true);
    try {
      await api.put("/auth/password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(t("settings.account.passwordUpdated"));
    } catch (err) {
      setError(errorMessage(err, t("settings.account.passwordFailed")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SettingRow label={t("settings.account.password")}>
      <form onSubmit={handleSubmit} className="max-w-sm space-y-2">
        <PasswordInput
          placeholder={t("settings.account.currentPassword")}
          value={currentPassword}
          onChange={setCurrentPassword}
          required
          autoComplete="current-password"
        />
        <PasswordInput
          placeholder={t("settings.account.newPassword")}
          value={newPassword}
          onChange={setNewPassword}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <PasswordInput
          placeholder={t("settings.account.confirmPassword")}
          value={confirmPassword}
          onChange={setConfirmPassword}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <FormMessage error={error} success={success} />
        <Button size="sm" type="submit" variant="secondary" loading={submitting}>
          {t("settings.account.updatePassword")}
        </Button>
      </form>
    </SettingRow>
  );
}
