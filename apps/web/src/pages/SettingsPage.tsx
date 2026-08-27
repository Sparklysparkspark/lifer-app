import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import BackToCollectionLink from "../components/BackToCollectionLink";
import { useDesktopMode } from "../hooks/useDesktopMode";
import { useMigrationStatus } from "../hooks/useMigrationStatus";
import { useTheme } from "../hooks/useTheme";

interface AccountSettings {
  email: string;
  recoveryEmail: string | null;
}

// Injected by the desktop app's preload script (apps/desktop/src/preload.js) — absent
// entirely in a normal browser tab, which is what ServerSection uses to decide whether to
// render at all.
interface DesktopBridgeConfig {
  mode: "local" | "remote";
  dataDir?: string;
  serverUrl?: string;
  offlineMode?: boolean;
}
declare global {
  interface Window {
    liferSetup?: {
      choose: (config: {
        mode: "local" | "remote";
        serverUrl?: string;
        offlineMode?: boolean;
      }) => Promise<{ ok?: boolean; canceled?: boolean; error?: string }>;
      getConfig: () => Promise<DesktopBridgeConfig | null>;
      platform: string;
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
    <div className="min-h-screen bg-canvas">
      <header className="page-header border-b border-line bg-surface px-6 py-4">
        <BackToCollectionLink className="text-sm text-muted hover:underline" />
        <h1 className="mt-1 text-lg font-semibold text-ink">Settings</h1>
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
            <LibraryLinksSection />
            <AppearanceSection />
            <HideObscureSpeciesSection />
            <OrganizePhotosSection />
            <StorageLocationSection />
            <LibraryReimportSection />
            <ServerSection />
            <AppUpdatesSection />
            <MapSection />
          </>
        )}
      </main>
    </div>
  );
}

// Moved out of the main collection page's nav bar to declutter it — these are occasional,
// not everyday actions, so Settings is a better home than a permanent top-bar link.
function LibraryLinksSection() {
  return (
    <Card title="Library" description="Manage your offline reference data and archived species.">
      <div className="flex flex-wrap gap-3">
        <Link to="/offline-packs" className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
          Offline packs
        </Link>
        <Link to="/archived" className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted">
          Archived species
        </Link>
      </div>
    </Card>
  );
}

function AppearanceSection() {
  const { preference, setPreference } = useTheme();
  const options = [
    { value: "system", label: "Follow system" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ] as const;
  return (
    <Card title="Appearance" description="Light or dark mode, or follow whatever this device is set to.">
      <div className="flex gap-2">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setPreference(opt.value)}
            className={
              preference === opt.value
                ? "rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg"
                : "rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
            }
          >
            {opt.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

// Moved off the collection page's per-view filter bar (migration 038) — a persisted account
// preference instead, applied automatically to every region/collection view without a
// visible toggle cluttering that page.
function HideObscureSpeciesSection() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ hideObscureSpecies: boolean }>("/settings").then((res) => setEnabled(res.hideObscureSpecies));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.put("/settings/hide-obscure-species", { enabled: next });
      setEnabled(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update this setting");
    } finally {
      setSaving(false);
    }
  }

  if (enabled === null) return null;

  return (
    <Card
      title="Obscure & inaccessible species"
      description="Hides deep-water fish (beyond recreational/technical diving depth) and species with almost no historical record — mostly ones nobody will realistically encounter. Anything you've already collected or seen always stays visible regardless."
    >
      <label className="flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" checked={enabled} disabled={saving} onChange={(e) => toggle(e.target.checked)} className="mt-0.5" />
        <span>Hide obscure/inaccessible species from region checklists</span>
      </label>
      <FormMessage error={error} success={null} />
    </Card>
  );
}

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-xs text-muted">{description}</p>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function FormMessage({ error, success }: { error: string | null; success: string | null }) {
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (success) return <p className="text-sm text-green-700">{success}</p>;
  return null;
}

const inputClass = "w-full rounded-md border border-line px-3 py-2 text-sm";
const buttonClass = "rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50";

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
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => toggle(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Organize into <code className="text-xs text-muted">Wildlife &lt;year taken&gt;/Birds|Mammals|Fish/Species name</code> folders
          instead of just <code className="text-xs text-muted">Species name</code> — each photo's own year, not the year you uploaded it
        </span>
      </label>
      <div>
        <button
          type="button"
          onClick={reorganizeNow}
          disabled={reorganizing}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          {reorganizing ? "Reorganizing…" : "Reorganize existing photos now"}
        </button>
      </div>
      <FormMessage error={error} success={result} />
    </Card>
  );
}

interface ReimportStatus {
  running: boolean;
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  error: string | null;
  finishedAt: number | null;
  jpegsRecovered: number;
  jpegsAlreadyKnown: number;
  jpegsUnrecognized: string[];
  jpegsAmbiguous: Array<{ file: string; scientificNames: string[] }>;
  rawsRecovered: number;
  rawsAlreadyKnown: number;
  rawsUnmatched: number;
  missingReferenceData: string[];
}

// Rebuilds captures/photos/user_species/originals from a species-organized library that's
// already on disk but has no database rows pointing at it — the fresh-install/migrated-server
// recovery path (see apps/api/src/library/reimport.ts's own comment on why this reads embedded
// file metadata rather than trusting folder names). Desktop-only for the same reason as
// StorageLocationSection above: it walks the server's own filesystem directly.
function LibraryReimportSection() {
  const [status, setStatus] = useState<ReimportStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ReimportStatus>("/library/reimport/status")
      .then(setStatus)
      .catch(() => {
        // 404s outside desktop mode — this section just won't render (see below).
      });
  }, []);

  // Same recursive setTimeout poll pattern as TripDetailPage's scan/import status polling.
  useEffect(() => {
    if (!status?.running) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await api.get<ReimportStatus>("/library/reimport/status");
        if (cancelled) return;
        setStatus(res);
        if (!res.running) return;
      } catch {
        // ignore — status just won't update this tick
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running]);

  async function start() {
    if (
      !confirm(
        "This walks your whole photo library on disk and rebuilds any captures/species records missing from the database. It never modifies or moves your files. Continue?",
      )
    )
      return;
    setStarting(true);
    setError(null);
    try {
      await api.post("/library/reimport");
      setStatus(await api.get<ReimportStatus>("/library/reimport/status"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the reimport");
    } finally {
      setStarting(false);
    }
  }

  if (status === null) return null;

  return (
    <Card
      title="Reimport library"
      description="Rebuild your species records straight from the photos already organized on disk — for after a fresh install or server migration where the database doesn't know about them yet."
    >
      <div>
        <button
          type="button"
          onClick={start}
          disabled={starting || status.running}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          {status.running ? "Reimporting…" : "Reimport library now"}
        </button>
      </div>
      {status.running && (
        <p className="text-xs text-muted">
          Photos: {status.processedJpegs}/{status.totalJpegs} · RAW files: {status.processedRaws}/{status.totalRaws}
        </p>
      )}
      {!status.running && status.finishedAt !== null && (
        <div className="space-y-2 text-xs text-muted">
          <p>
            Recovered {status.jpegsRecovered} photo{status.jpegsRecovered === 1 ? "" : "s"}
            {status.jpegsAlreadyKnown > 0 && ` (${status.jpegsAlreadyKnown} already known)`}
            {status.rawsRecovered > 0 && ` and matched ${status.rawsRecovered} RAW file${status.rawsRecovered === 1 ? "" : "s"}`}.
          </p>
          {status.jpegsUnrecognized.length > 0 && (
            <p>
              {status.jpegsUnrecognized.length} photo{status.jpegsUnrecognized.length === 1 ? "" : "s"} had no recognizable species
              metadata and were skipped.
            </p>
          )}
          {status.jpegsAmbiguous.length > 0 && (
            <p>
              {status.jpegsAmbiguous.length} photo{status.jpegsAmbiguous.length === 1 ? "" : "s"} matched more than one possible
              species and were skipped for manual review.
            </p>
          )}
          {status.rawsUnmatched > 0 && (
            <p>
              {status.rawsUnmatched} RAW file{status.rawsUnmatched === 1 ? "" : "s"} couldn't be matched to a recovered photo.
            </p>
          )}
          {status.missingReferenceData.length > 0 && (
            <p>
              {status.missingReferenceData.length} recovered species {status.missingReferenceData.length === 1 ? "is" : "are"} missing
              reference photos/descriptions —{" "}
              <Link
                to={`/offline-packs?missing=${encodeURIComponent(status.missingReferenceData.join(","))}`}
                className="underline hover:no-underline"
              >
                see which packs would restore them
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {status.error && <p className="text-sm text-red-600">{status.error}</p>}
      <FormMessage error={error} success={null} />
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
      <p className="text-sm text-ink">
        Currently: <code className="text-xs">{currentDataDir}</code>
      </p>
      {!browsing ? (
        <button
          type="button"
          onClick={() => browse()}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
        >
          Choose a different folder…
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-line p-3">
          <p className="truncate text-xs text-muted">{browsing.path}</p>
          <div className="max-h-48 space-y-0.5 overflow-y-auto">
            {browsing.parent && (
              <button
                onClick={() => browse(browsing.parent!)}
                className="block w-full rounded px-2 py-1 text-left text-sm text-muted hover:bg-surface-muted"
              >
                .. (up one level)
              </button>
            )}
            {browsing.entries.map((entry) => (
              <button
                key={entry.path}
                onClick={() => browse(entry.path)}
                className="block w-full rounded px-2 py-1 text-left text-sm text-ink hover:bg-surface-muted"
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
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted"
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

// One merged "Connect a server" flow for the desktop app (only renders inside it —
// window.liferSetup is absent in a normal browser tab). Used to be two disconnected cards
// ("Where this window looks" and "Migrate to a server") asking for the same server URL in two
// different forms; merged per explicit feedback that the split was confusing. The steps stay
// sequential though, since they genuinely are: migrate your photos up first, confirm it went
// cleanly, THEN either switch this window over to the server, or additionally free up local
// disk space — each its own explicit action, never automatic.
function ServerSection() {
  const [config, setConfig] = useState<DesktopBridgeConfig | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [offlineMode, setOfflineMode] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  // Shares the exact same polled status the header indicator uses, so this card and the
  // header always agree on whether a migration is running and how far along it is.
  const status = useMigrationStatus();

  useEffect(() => {
    window.liferSetup?.getConfig().then(setConfig);
  }, []);

  async function connectToServer() {
    setError(null);
    setBusy(true);
    try {
      const result = await window.liferSetup!.choose({ mode: "remote", serverUrl, offlineMode });
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
    } finally {
      setBusy(false);
    }
  }

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

  async function deleteLocalFiles() {
    if (
      !confirm(
        "Permanently delete every local photo and capture on this computer? Only do this once you've confirmed they're all safely on the server. This can't be undone.",
      )
    ) {
      return;
    }
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.post("/settings/delete-local-library", { confirm: true });
      setDeleted(true);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't delete your local files");
    } finally {
      setDeleting(false);
    }
  }

  if (!window.liferSetup || !config) return null;

  // "Confirmed fully migrated": the last run finished, is not still running, and had zero
  // failures — anything less and there could be photos the server never actually received.
  const cleanMigration = status && !status.running && status.finishedAt != null && status.failed === 0;

  if (config.mode === "remote") {
    return (
      <Card title="Connect a server" description={`Showing the library on ${config.serverUrl}.`}>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          onClick={switchToLocal}
          disabled={busy}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          Switch to local library
        </button>
      </Card>
    );
  }

  return (
    <Card
      title="Connect a server"
      description="Move your library to a Lifer server you run elsewhere. Migrate your photos up, confirm nothing failed, then switch this window over — your local copies stay put until you separately choose to delete them."
    >
      {status?.running ? (
        <p className="text-sm text-muted">
          Migrating to {status.serverUrl} — {status.migrated + status.skipped + status.failed} of {status.total} processed
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
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={offlineMode} onChange={(e) => setOfflineMode(e.target.checked)} className="mt-0.5" />
            <span>
              Keep an offline cache after connecting — low-res cover photos and your collected/seen status stay
              browsable here even if this computer loses its connection to the server.
            </span>
          </label>
          <FormMessage error={error ?? status?.error ?? null} success={null} />
          <button type="submit" disabled={starting} className={buttonClass}>
            {starting ? "Starting…" : "Migrate my library"}
          </button>
        </form>
      )}

      {status && !status.running && status.finishedAt != null && (
        <div className="space-y-3 border-t border-line pt-3">
          <p className={cleanMigration ? "text-sm text-green-700" : "text-sm text-red-600"}>
            Last run: migrated {status.migrated} of {status.total} ({status.skipped} skipped, {status.failed} failed).
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={connectToServer} disabled={busy} className={buttonClass}>
              Switch this window to the server
            </button>
            {cleanMigration && !deleted && (
              <button
                type="button"
                onClick={deleteLocalFiles}
                disabled={deleting}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete local files now that they're on the server"}
              </button>
            )}
          </div>
          {deleted && <p className="text-sm text-green-700">Local files deleted.</p>}
          <FormMessage error={deleteError} success={null} />
        </div>
      )}
    </Card>
  );
}

// Desktop-only, same window.liferSetup gating as StorageLocationSection/ServerSection above.
// Dynamically imports @tauri-apps/plugin-updater/-process rather than a top-level import —
// this file is also built and served to a plain browser tab / Docker deployment, where
// window.__TAURI_INTERNALS__ never exists, so the actual invoke() calls those packages make
// must never run there. A dynamic import keeps that code out of the initial bundle entirely
// and only ever executes from inside this component's own (already-gated) event handlers.
function AppUpdatesSection() {
  type CheckResult = { version: string; body?: string; downloadAndInstall: (onEvent: (e: DownloadEventLike) => void) => Promise<void> };
  type DownloadEventLike =
    | { event: "Started"; data: { contentLength?: number } }
    | { event: "Progress"; data: { chunkLength: number } }
    | { event: "Finished" };

  const [status, setStatus] = useState<"idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "error">("idle");
  const [update, setUpdate] = useState<CheckResult | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function checkForUpdate() {
    setStatus("checking");
    setError(null);
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const result = await check();
      if (result) {
        setUpdate(result);
        setStatus("available");
      } else {
        setUpdate(null);
        setStatus("up-to-date");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't check for updates");
      setStatus("error");
    }
  }

  async function installUpdate() {
    if (!update) return;
    setStatus("downloading");
    setError(null);
    let totalBytes: number | null = null;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
          setProgress({ downloaded: 0, total: totalBytes });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress({ downloaded, total: totalBytes });
        } else if (event.event === "Finished") {
          setStatus("installing");
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't install the update");
      setStatus("error");
    }
  }

  if (!window.liferSetup) return null;

  return (
    <Card title="App updates" description="Check for and install a newer version of Lifer.">
      {status === "idle" && (
        <button type="button" onClick={checkForUpdate} className={buttonClass}>
          Check for updates
        </button>
      )}
      {status === "checking" && <p className="text-sm text-muted">Checking…</p>}
      {status === "up-to-date" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">You're on the latest version.</p>
          <button type="button" onClick={checkForUpdate} className="text-sm text-ink underline">
            Check again
          </button>
        </div>
      )}
      {status === "available" && update && (
        <div className="space-y-2">
          <p className="text-sm text-ink">Version {update.version} is available.</p>
          {update.body && <p className="text-sm text-muted">{update.body}</p>}
          <button type="button" onClick={installUpdate} className={buttonClass}>
            Download and install
          </button>
        </div>
      )}
      {(status === "downloading" || status === "installing") && (
        <p className="text-sm text-muted">
          {status === "installing"
            ? "Installing — Lifer will restart shortly…"
            : progress?.total
              ? `Downloading… ${Math.round((progress.downloaded / progress.total) * 100)}%`
              : "Downloading…"}
        </p>
      )}
      <FormMessage error={error} success={null} />
    </Card>
  );
}

// Offline basemap tiles are a large (~500MB) opt-in download, not something every install
// ships with (see config.ts's MAP_DOWNLOAD_URL) — purely a cosmetic nicety on region/species
// range maps, not worth doubling the install size for everyone by default.
function MapSection() {
  const [status, setStatus] = useState<{
    available: boolean;
    downloaded: boolean;
    downloading: boolean;
    downloadedBytes: number;
    totalBytes: number | null;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let nextDelay = 5000;
      try {
        const res = await api.get<NonNullable<typeof status>>("/settings/map/status");
        if (!cancelled) setStatus(res);
        nextDelay = res.downloading ? 1000 : 5000;
      } catch {
        if (!cancelled) setStatus(null);
      }
      if (!cancelled) timer = setTimeout(poll, nextDelay);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function download() {
    if (!confirm("Download the offline basemap? It's about 500MB and only affects range map visuals — nothing else in Lifer needs it.")) {
      return;
    }
    setBusy(true);
    try {
      await api.post("/settings/map/download");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete the downloaded offline map to reclaim disk space? You can download it again anytime.")) return;
    setBusy(true);
    try {
      await api.delete("/settings/map");
    } finally {
      setBusy(false);
    }
  }

  if (!status || !status.available) return null;

  return (
    <Card
      title="Offline map"
      description="An offline basemap for range maps, so they render without an internet connection. Purely cosmetic — nothing else in Lifer depends on it."
    >
      {status.downloading ? (
        <p className="text-sm text-muted">
          Downloading… {(status.downloadedBytes / 1e6).toFixed(0)}MB
          {status.totalBytes ? ` of ${(status.totalBytes / 1e6).toFixed(0)}MB` : ""}
        </p>
      ) : status.downloaded ? (
        <div className="space-y-2">
          <p className="text-sm text-green-700">Downloaded.</p>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink hover:bg-surface-muted disabled:opacity-50"
          >
            Delete to reclaim space
          </button>
        </div>
      ) : (
        <button type="button" onClick={download} disabled={busy} className={buttonClass}>
          Download offline map (~500MB)
        </button>
      )}
      {status.error && <p className="text-sm text-red-600">{status.error}</p>}
    </Card>
  );
}
