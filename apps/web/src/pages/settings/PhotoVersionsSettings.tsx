// Settings > Species and import > Photo versions: the folder names whose files are versions of
// the original beside them, and looking again in one folder (apps/api/src/captures/versions.ts).
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import TextField from "../../components/TextField";
import { FolderBrowser } from "../../components/FolderPicker";
import { ScopeChip } from "../../components/PhotoFiltersMenu";
import { useJobPoll } from "../../hooks/useJobPoll";
import { useApiRoute } from "../../lib/resource";
import { docsUrl } from "../../lib/docs";
import { errorMessage } from "../../lib/errorMessage";
import { openExternal } from "../../lib/openExternal";
import { pickFolderNative } from "../../lib/pickFolderNative";
import { notifyVersionChange } from "../../lib/photoVersions";
import { SettingRow, SettingsGroup } from "./shared";

const SCAN = "/captures/versions/scan";

export default function PhotoVersionsSettings() {
  const { t } = useTranslation();
  const folders = useApiRoute(apiPath("/captures/versions/folders", {}));
  const [names, setNames] = useState<string[] | null>(null);
  const shown = names ?? folders.data?.names ?? null;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  // The pass also runs after imports; only a look started here reports what it found.
  const [lookedHere, setLookedHere] = useState(false);
  const scan = useJobPoll<JobStatus<{ linked: number; suggested: number }>>(SCAN, {
    idleIntervalMs: null,
    onFinish: () => notifyVersionChange(),
  });
  const status = scan.status;

  // Saved at once: the list is short and every change is easy to take back.
  async function save(next: string[] | null) {
    setError(null);
    const before = shown;
    if (next) setNames(next);
    try {
      const res = await api.put(apiPath("/captures/versions/folders", {}), { names: next });
      setNames(res.names);
    } catch (err) {
      setNames(before);
      setError(errorMessage(err, t("settings.versions.saveFailed")));
    }
  }
  function add(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name || !shown) return;
    setDraft("");
    if (!shown.some((n) => n.toLowerCase() === name.toLowerCase())) void save([...shown, name]);
  }

  async function look(folder: string) {
    setError(null);
    setLookedHere(await scan.start(SCAN, { folder }));
  }
  async function choose() {
    const native = await pickFolderNative();
    if (native === undefined) setBrowsing(true);
    else if (native !== null) await look(native);
  }

  const isDefault =
    !!shown &&
    !!folders.data &&
    shown.length === folders.data.defaults.length &&
    shown.every((n, i) => n === folders.data!.defaults[i]);
  const result =
    lookedHere && !status?.running && status?.finishedAt != null && !status.error && !status.cancelled && status.result;

  return (
    <SettingsGroup title={t("settings.versions.title")}>
      <SettingRow
        label={t("settings.versions.howLabel")}
        description={t("settings.versions.howDescription")}
        control={
          <Button variant="link" size="sm" onClick={() => openExternal(docsUrl("/guides/photo-versions"))}>
            {t("settings.versions.guide")}
          </Button>
        }
      />
      <SettingRow
        label={t("settings.versions.foldersLabel")}
        description={t("settings.versions.foldersDescription")}
        control={
          !isDefault && (
            <Button variant="secondary" size="sm" onClick={() => void save(null)}>
              {t("settings.versions.resetFolders")}
            </Button>
          )
        }
      >
        {shown && (
          <div className="flex flex-wrap gap-1.5" role="list" aria-label={t("settings.versions.foldersLabel")}>
            {shown.map((name) => (
              <span role="listitem" key={name} className="max-w-full">
                <ScopeChip label={name} onRemove={() => void save(shown.filter((n) => n !== name))} />
              </span>
            ))}
          </div>
        )}
        <form onSubmit={add} className="flex max-w-sm items-center gap-2">
          <TextField
            size="sm"
            value={draft}
            maxLength={60}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("settings.versions.addPlaceholder")}
            aria-label={t("settings.versions.addLabel")}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!draft.trim()}>
            {t("settings.versions.add")}
          </Button>
        </form>
      </SettingRow>
      <SettingRow
        label={t("settings.versions.lookLabel")}
        description={t("settings.versions.lookDescription")}
        control={
          !status?.running && (
            <Button variant="secondary" size="sm" onClick={() => void choose()} loading={scan.starting}>
              {t("settings.versions.look")}
            </Button>
          )
        }
      >
        {status?.running && (
          <JobProgress
            compact
            status={status}
            fallbackLabel={t("settings.versions.looking")}
            onCancel={() => void scan.cancel(`${SCAN}/cancel`)}
            cancelling={scan.cancelling}
          />
        )}
        {result && (
          <FormMessage
            success={
              result.linked + result.suggested === 0
                ? t("settings.versions.foundNone")
                : t("settings.versions.found", { linked: result.linked, suggested: result.suggested })
            }
          />
        )}
        <FormMessage error={error ?? scan.actionError} />
        {browsing && (
          <FolderBrowser
            onChoose={(p) => {
              setBrowsing(false);
              void look(p);
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
