import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import Button from "../../components/Button";
import Switch from "../../components/Switch";
import FormMessage from "../../components/FormMessage";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import LibraryReimportSection from "./LibraryReimportSection";
import { SettingRow, SettingsGroup } from "./shared";

export default function LibrarySettings() {
  return (
    <>
      <SettingsGroup title="Library">
        <LibraryLinksRows />
        <OrganizePhotosRows />
      </SettingsGroup>
      <LibraryReimportSection />
    </>
  );
}

const LIBRARY_PAGES = [
  { to: "/offline-packs", label: "Offline packs" },
  { to: "/archived", label: "Archived species" },
  { to: "/hidden-species", label: "Hidden species" },
  { to: "/trash", label: "Trash" },
  { to: "/tags", label: "Tags" },
];

function LibraryLinksRows() {
  const dataDir = useServerInfo()?.dataDir;
  return (
    <>
      {dataDir && (
        <SettingRow
          label="Location"
          description={
            <span className="block truncate font-mono" title={dataDir}>
              {dataDir}
            </span>
          }
        />
      )}
      <SettingRow label="Manage">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {LIBRARY_PAGES.map((p) => (
            <Link key={p.to} to={p.to} className="text-ink underline">
              {p.label}
            </Link>
          ))}
        </div>
      </SettingRow>
    </>
  );
}

const pathChip = "font-mono";

// Toggling only affects future uploads; existing files move only via the explicit "Reorganize now".
function OrganizePhotosRows() {
  const { settings, setLocal } = useSettings();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!settings) return null;

  async function save(
    endpoint: string,
    patch: { organizeOriginalsByYear: boolean } | { organizeOriginalsByLocation: boolean },
    next: boolean,
  ) {
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
      const res = await api.post("/settings/reorganize-originals");
      setResult(`Moved ${res.moved} of ${res.total} files (${res.skipped} already in place, ${res.failed} failed).`);
    } catch (err) {
      setError(errorMessage(err, "Couldn't reorganize your photos"));
    } finally {
      setReorganizing(false);
    }
  }

  return (
    <>
      <SettingRow
        label="Folders by year"
        description={
          <>
            Files originals under <span className={pathChip}>Wildlife &lt;year taken&gt;/Birds/Species name</span>{" "}
            instead of just <span className={pathChip}>Species name</span>.
          </>
        }
        control={
          <Switch
            label="Folders by year"
            checked={settings.organizeOriginalsByYear}
            disabled={saving}
            onChange={(next) => void save("/settings/organize-originals", { organizeOriginalsByYear: next }, next)}
          />
        }
      />
      <SettingRow
        label="Folders by location"
        description={
          <>
            Adds an outer folder named after the location you enter at import, like{" "}
            <span className={pathChip}>Prince George/Birds/Species name</span>.
          </>
        }
        control={
          <Switch
            label="Folders by location"
            checked={settings.organizeOriginalsByLocation}
            disabled={saving}
            onChange={(next) =>
              void save("/settings/organize-originals-by-location", { organizeOriginalsByLocation: next }, next)
            }
          />
        }
      />
      <SettingRow
        label="Reorganize existing photos"
        description="The folder settings apply to new photos; this moves files already on disk to match."
        control={
          <Button variant="secondary" size="sm" onClick={reorganizeNow} loading={reorganizing}>
            {reorganizing ? "Reorganizing…" : "Reorganize"}
          </Button>
        }
      >
        {(error || result) && <FormMessage error={error} success={result} />}
      </SettingRow>
    </>
  );
}
