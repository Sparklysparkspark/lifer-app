import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";
import { useDesktopMode } from "../hooks/useDesktopMode";
import { useMigrationStatus } from "../hooks/useMigrationStatus";

interface AccountSettings {
  email: string;
  recoveryEmail: string | null;
}

// Injected by the desktop app's preload script (apps/desktop/src/preload.js) — absent
// entirely in a normal browser tab, which is what ElectronBridgeSection/MigrateToServerSection
// use to decide whether to render at all.
interface DesktopBridgeConfig {
  mode: "local" | "remote";
  dataDir?: string;
  serverUrl?: string;
}
declare global {
  interface Window {
    liferSetup?: {
      choose: (config: { mode: "local" | "remote"; serverUrl?: string }) => Promise<{ ok?: boolean; canceled?: boolean; error?: string }>;
      getConfig: () => Promise<DesktopBridgeConfig | null>;
    };
  }
}

// Account management: password, email, and recovery email. Every field here requires the
// current password to change (see auth/routes.ts) — these are all account-security-sensitive,
// so a stolen session cookie alone shouldn't be enough to take over the account.
export default function SettingsPage() {
  const [settings, setSettings] = useState<AccountSettings | null>(null);
  const isDesktopMode = useDesktopMode();

  useEffect(() => {
    api.get<AccountSettings>("/auth/settings").then(setSettings);
  }, []);

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-stone-200 bg-white px-6 py-4">
        <BackToCollectionLink className="text-sm text-stone-500 hover:underline" />
        <h1 className="mt-1 text-lg font-semibold text-stone-900">Settings</h1>
      </header>

      <main className="mx-auto max-w-lg space-y-8 p-6">
        {settings && (
          <>
            {/* Desktop mode's account is an auto-provisioned local user with no real
               password (see session.ts), so these settings wouldn't even work there;
               hidden rather than shown broken. */}
            {!isDesktopMode && (
              <>
                <EmailSection currentEmail={settings.email} onChanged={(email) => setSettings({ ...settings, email })} />
                <PasswordSection />
                <RecoveryEmailSection
                  currentRecoveryEmail={settings.recoveryEmail}
                  onChanged={(recoveryEmail) => setSettings({ ...settings, recoveryEmail })}
                />
              </>
            )}
            <OrganizePhotosSection />
            <StorageLocationSection />
            <ElectronBridgeSection />
            <MigrateToServerSection />
          </>
        )}
      </main>
    </div>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5">
      <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
      <p className="mt-1 text-xs text-stone-500">{description}</p>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function FormMessage({ error, success }: { error: string | null; success: string | null }) {
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (success) return <p className="text-sm text-green-700">{success}</p>;
  return null;
}

const inputClass = "w-full rounded-md border border-stone-300 px-3 py-2 text-sm";
const buttonClass = "rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50";

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
      setError(err instanceof ApiError ? err.message : "Couldn't update email");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Email" description={`Currently signed in as ${currentEmail}.`}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          placeholder="New email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          required
          className={inputClass}
        />
        <input
          type="password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <button type="submit" disabled={submitting} className={buttonClass}>
          Update email
        </button>
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
      setError(err instanceof ApiError ? err.message : "Couldn't update password");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Password" description="Change your account password.">
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          className={inputClass}
        />
        <input
          type="password"
          placeholder="New password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={8}
          className={inputClass}
        />
        <input
          type="password"
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          minLength={8}
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <button type="submit" disabled={submitting} className={buttonClass}>
          Update password
        </button>
      </form>
    </Card>
  );
}

function RecoveryEmailSection({
  currentRecoveryEmail,
  onChanged,
}: {
  currentRecoveryEmail: string | null;
  onChanged: (recoveryEmail: string | null) => void;
}) {
  const [recoveryEmail, setRecoveryEmail] = useState(currentRecoveryEmail ?? "");
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
      const res = await api.put<{ recoveryEmail: string | null }>("/auth/recovery-email", {
        currentPassword,
        recoveryEmail: recoveryEmail || null,
      });
      onChanged(res.recoveryEmail);
      setCurrentPassword("");
      setSuccess("Recovery email updated.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update recovery email");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      title="Recovery email"
      description="Where a 'forgot password' link gets sent. Leave blank to use your login email instead."
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="email"
          placeholder="Recovery email (optional)"
          value={recoveryEmail}
          onChange={(e) => setRecoveryEmail(e.target.value)}
          className={inputClass}
        />
        <input
          type="password"
          placeholder="Current password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
          className={inputClass}
        />
        <FormMessage error={error} success={success} />
        <button type="submit" disabled={submitting} className={buttonClass}>
          Save
        </button>
      </form>
    </Card>
  );
}

// Optionally organizes stored originals into year/taxon-class folders (handy for importing
// into other photo tools). Toggling only changes where future uploads land — existing files
// need the separate, explicit "Reorganize now" action (see settings/routes.ts's own comment
// on why that's not automatic).
function OrganizePhotosSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ organizeOriginalsByYear: boolean }>("/settings").then((res) => setEnabled(res.organizeOriginalsByYear));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.put("/settings/organize-originals", { enabled: next });
      setEnabled(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update this setting");
    } finally {
      setSaving(false);
    }
  }

  async function reorganizeNow() {
    if (!confirm("This moves your existing photo files on disk to match the current setting. Continue?")) return;
    setReorganizing(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ moved: number; skipped: number; failed: number; total: number }>(
        "/settings/reorganize-originals",
      );
      setResult(`Moved ${res.moved} of ${res.total} files (${res.skipped} already in place, ${res.failed} failed).`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't reorganize your photos");
    } finally {
      setReorganizing(false);
    }
  }

  if (enabled === null) return null;

  return (
    <Card
      title="Photo library organization"
      description="Where full-resolution originals get filed on disk — useful if you ever want to browse or import your library outside Lifer (e.g. into Immich)."
    >
      <label className="flex items-start gap-2 text-sm text-stone-700">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Organize into <code className="text-xs text-stone-500">Wildlife &lt;year taken&gt;/Birds|Mammals|Fish/Species name</code> folders
          instead of just <code className="text-xs text-stone-500">Species name</code> — each photo's own year, not the year you uploaded it
        </span>
      </label>
      <div>
        <button
          type="button"
          onClick={reorganizeNow}
          disabled={reorganizing}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
        >
          {reorganizing ? "Reorganizing…" : "Reorganize existing photos now"}
        </button>
      </div>
      <FormMessage error={error} success={result} />
    </Card>
  );
}

interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

// Desktop-mode only (see settings/routes.ts's requireDesktopMode) — the Docker deployment
// already has LIFER_STORAGE_DIR for this (see .env.example). GET /settings/storage 404s
// outside desktop mode, which is how this section knows to just not render at all.
function StorageLocationSection() {
  const [available, setAvailable] = useState(false);
  const [currentDataDir, setCurrentDataDir] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState<DirectoryListing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ dataDir: string }>("/settings/storage")
      .then((res) => {
        setAvailable(true);
        setCurrentDataDir(res.dataDir);
      })
      .catch(() => setAvailable(false));
  }, []);

  function browse(dirPath?: string) {
    setError(null);
    api
      .get<DirectoryListing>(`/settings/browse-directory${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ""}`)
      .then(setBrowsing)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't browse that folder"));
  }

  async function chooseThisFolder() {
    if (!browsing) return;
    if (
      !confirm(
        `Move your photo library from ${currentDataDir} to ${browsing.path}? This moves every file and updates Lifer's records to match.`,
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.put<{ dataDir: string; filesMoved: boolean }>("/settings/storage", {
        dataDir: browsing.path,
      });
      setResult(
        res.filesMoved
          ? "Your library has been moved. Restart Lifer for the new location to take effect."
          : "Saved. Restart Lifer for the new location to take effect.",
      );
      setCurrentDataDir(res.dataDir);
      setBrowsing(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't move this library");
    } finally {
      setSaving(false);
    }
  }

  if (!available) return null;

  return (
    <Card
      title="Storage location"
      description="Where your photo library lives on this computer, instead of buried inside the app's own files."
    >
      <p className="text-sm text-stone-700">
        Currently: <code className="text-xs">{currentDataDir}</code>
      </p>
      {!browsing ? (
        <button
          type="button"
          onClick={() => browse()}
          className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
        >
          Choose a different folder…
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-stone-200 p-3">
          <p className="truncate text-xs text-stone-500">{browsing.path}</p>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {browsing.parent && (
              <button
                onClick={() => browse(browsing.parent!)}
                className="block w-full rounded px-2 py-1 text-left text-sm text-stone-600 hover:bg-stone-100"
              >
                .. (up one level)
              </button>
            )}
            {browsing.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => browse(entry.path)}
                className="block w-full rounded px-2 py-1 text-left text-sm text-stone-700 hover:bg-stone-100"
              >
                {entry.name}
              </button>
            ))}
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={chooseThisFolder}
              disabled={saving}
              className={buttonClass}
            >
              Use this folder
            </button>
            <button
              type="button"
              onClick={() => setBrowsing(null)}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <FormMessage error={error} success={result} />
    </Card>
  );
}

// Lets the desktop app switch between local library and remote server storage. Only renders
// inside the desktop app (window.liferSetup is absent in a normal browser tab). Switching
// modes navigates this whole window to wherever the new mode points — local's own server, or
// the remote one — so this component itself unmounts as part of a successful switch, not
// something it needs to handle explicitly.
function ElectronBridgeSection() {
  const [config, setConfig] = useState<DesktopBridgeConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.liferSetup?.getConfig().then(setConfig);
  }, []);

  async function connectToServer(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await window.liferSetup!.choose({ mode: "remote", serverUrl });
      if (result.error) setError(result.error);
    } finally {
      setBusy(false);
    }
  }

  async function switchToLocal() {
    setError(null);
    setBusy(true);
    try {
      const result = await window.liferSetup!.choose({ mode: "local" });
      if (result.error) setError(result.error);
      // result.canceled: the folder dialog was dismissed — nothing changed, nothing to show.
    } finally {
      setBusy(false);
    }
  }

  if (!window.liferSetup || !config) return null;

  return (
    <Card
      title="App connection"
      description={config.mode === "local" ? "Using this Mac's own local library." : `Connected to ${config.serverUrl}.`}
    >
      {config.mode === "local" ? (
        <form onSubmit={connectToServer} className="space-y-3">
          <input
            type="text"
            placeholder="https://lifer.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
            className={inputClass}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className={buttonClass}>
            Connect to this server
          </button>
        </form>
      ) : (
        <div className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="button"
            onClick={switchToLocal}
            disabled={busy}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
          >
            Switch to local library
          </button>
        </div>
      )}
    </Card>
  );
}

// Lets the desktop app push its local library to a remote server. Only makes sense — and
// only renders — while actually using the local library; if already connected to a server,
// there's nothing local left to push. A one-way, explicit push (not a bidirectional sync)
// that replays every local capture as a normal upload against the target server's own API.
function MigrateToServerSection() {
  const [isLocal, setIsLocal] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Shares the exact same polled status the header indicator uses, so this card and the
  // header always agree on whether a migration is running and how far along it is, rather
  // than this card only knowing about a migration it started this page-load.
  const status = useMigrationStatus();

  useEffect(() => {
    window.liferSetup?.getConfig().then((config) => setIsLocal(config?.mode === "local"));
  }, []);

  async function migrate(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm(`Upload your entire local library to ${serverUrl}? This can take a while for a large library.`)) return;
    setError(null);
    setStarting(true);
    try {
      await api.post("/settings/migrate-to-server", { serverUrl, email, password });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the migration");
    } finally {
      setStarting(false);
    }
  }

  if (!window.liferSetup || !isLocal) return null;

  const done = status && !status.running && status.finishedAt != null;

  return (
    <Card
      title="Migrate to a server"
      description="Upload everything in this local library to a Lifer server you run elsewhere — a one-time copy, not ongoing sync. Safe to run again later: anything already migrated is skipped, and only what previously failed gets retried."
    >
      {status?.running ? (
        <p className="text-sm text-stone-600">
          Syncing to {status.serverUrl} — {status.migrated + status.skipped + status.failed} of {status.total} processed
          ({status.migrated} migrated, {status.skipped} skipped, {status.failed} failed so far).
        </p>
      ) : (
        <form onSubmit={migrate} className="space-y-3">
          <input
            type="text"
            placeholder="https://lifer.example.com"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            required
            className={inputClass}
          />
          <input
            type="email"
            placeholder="Email on that server"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={inputClass}
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={inputClass}
          />
          {done && !status.error && (
            <p className="text-sm text-green-700">
              Last run: migrated {status.migrated} of {status.total} ({status.skipped} skipped, {status.failed} failed).
            </p>
          )}
          <FormMessage error={error ?? status?.error ?? null} success={null} />
          <button type="submit" disabled={starting} className={buttonClass}>
            {starting ? "Starting…" : "Migrate my library"}
          </button>
        </form>
      )}
    </Card>
  );
}
