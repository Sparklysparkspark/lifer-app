import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button, { buttonClasses } from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import LibraryReimportSection from "./LibraryReimportSection";
import { Card } from "./shared";

export default function LibrarySettings() {
  return (
    <>
      <LibraryLinksSection />
      <OrganizePhotosSection />
      <LibraryReimportSection />
    </>
  );
}

function LibraryLinksSection() {
  const dataDir = useServerInfo()?.dataDir;
  const linkClass = buttonClasses("secondary", "sm");
  return (
    <Card title="Library" description="Manage your offline reference data and archived species." learnMore="library">
      {dataDir && (
        <p className="mb-3 truncate font-mono text-xs text-muted" title={dataDir}>
          {dataDir}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <Link to="/offline-packs" className={linkClass}>
          Offline packs
        </Link>
        <Link to="/archived" className={linkClass}>
          Archived species
        </Link>
        <Link to="/hidden-species" className={linkClass}>
          Hidden species
        </Link>
        <Link to="/trash" className={linkClass}>
          Trash
        </Link>
        <Link to="/tags" className={linkClass}>
          Manage tags
        </Link>
      </div>
    </Card>
  );
}

const pathChip = "rounded bg-surface-muted px-1 py-0.5 text-xs text-muted";

// Toggling only affects future uploads; existing files move only via the explicit "Reorganize now".
function OrganizePhotosSection() {
  const { settings, setLocal } = useSettings();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!settings) return null;

  async function save(endpoint: string, patch: { organizeOriginalsByYear: boolean } | { organizeOriginalsByLocation: boolean }, next: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.put(endpoint, { enabled: next });
      setLocal(patch);
    } catch (err) {
      setError(errorMessage(err, "Couldn't update this setting"));
    } finally {
      setSaving(false);
    }
  }

  async function reorganizeNow() {
    const ok = await confirm({
      title: "Reorganize existing photos?",
      message: "This moves your existing photo files on disk to match the current setting.",
      confirmLabel: "Reorganize",
    });
    if (!ok) return;
    setReorganizing(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post<{ moved: number; skipped: number; failed: number; total: number }>("/settings/reorganize-originals");
      setResult(`Moved ${res.moved} of ${res.total} files (${res.skipped} already in place, ${res.failed} failed).`);
    } catch (err) {
      setError(errorMessage(err, "Couldn't reorganize your photos"));
    } finally {
      setReorganizing(false);
    }
  }

  return (
    <Card
      title="Photo library organization"
      learnMore="photo-library-organization"
      description="Where full-resolution originals get filed on disk, useful if you ever want to browse or import your library outside Lifer (e.g. into Immich)."
    >
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={settings.organizeOriginalsByYear}
          disabled={saving}
          onChange={(e) => void save("/settings/organize-originals", { organizeOriginalsByYear: e.target.checked }, e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Organize into <span className={pathChip}>Wildlife &lt;year taken&gt;/Birds|Mammals|Fish/Species name</span> folders instead of
          just <span className={pathChip}>Species name</span>, using each photo's own year, not the year you uploaded it
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          checked={settings.organizeOriginalsByLocation}
          disabled={saving}
          onChange={(e) =>
            void save("/settings/organize-originals-by-location", { organizeOriginalsByLocation: e.target.checked }, e.target.checked)
          }
          className="mt-0.5"
        />
        <span>
          Add an outermost folder named after the location you type in at import time. Stacks with the year folders above (location
          comes first): with year folders on, that's <span className={pathChip}>Prince George/Wildlife &lt;year taken&gt;/Birds/Species name</span>
          , or just <span className={pathChip}>Prince George/Birds/Species name</span> with year folders off. Only applies to photos you
          actually gave a location to; everything else stays where it already would.
        </span>
      </label>
      <div>
        <Button variant="secondary" size="sm" onClick={reorganizeNow} loading={reorganizing}>
          {reorganizing ? "Reorganizing…" : "Reorganize existing photos now"}
        </Button>
      </div>
      <FormMessage error={error} success={result} />
    </Card>
  );
}
