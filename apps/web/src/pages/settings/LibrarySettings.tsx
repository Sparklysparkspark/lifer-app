import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FOLDER_LAYOUT_PRESETS,
  FOLDER_LEVELS,
  folderLayoutPreset,
  type FolderLayoutPreset,
  type FolderLevel,
} from "@lifer/shared";
import { api, apiPath } from "../../api/client";
import Button from "../../components/Button";
import Select from "../../components/Select";
import FormMessage from "../../components/FormMessage";
import { useServerInfo } from "../../hooks/useDeploymentMode";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import LibraryReimportSection from "./LibraryReimportSection";
import BringInWorkGroup from "./BringInWorkGroup";
import WatchedFoldersGroup from "./WatchedFoldersGroup";
import { SettingLinkRow, SettingRow, SettingsGroup } from "./shared";
import FolderPath from "../../components/FolderPath";
import InfoTip from "../../components/InfoTip";
import OrderedChecklist from "./OrderedChecklist";
import { FileNameRow } from "./MetadataSettings";

export default function LibrarySettings() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsGroup title={t("settings.groups.library")}>
        <LibraryLocationRow />
        <OrganizePhotosRows />
      </SettingsGroup>
      <LibraryPagesGroup />
      <WatchedFoldersGroup />
      <BringInWorkGroup />
      <LibraryReimportSection />
    </>
  );
}

const LIBRARY_PAGES = [
  { to: "/archived", labelKey: "settings.library.pages.archived" },
  { to: "/hidden-species", labelKey: "settings.library.pages.hidden" },
  { to: "/trash", labelKey: "settings.library.pages.trash" },
  { to: "/tags", labelKey: "settings.library.pages.tags" },
  { to: "/places", labelKey: "settings.library.pages.places" },
  { to: "/portfolio", labelKey: "settings.library.pages.portfolio" },
];

function LibraryLocationRow() {
  const { t } = useTranslation();
  const dataDir = useServerInfo()?.dataDir;
  if (!dataDir) return null;
  return <SettingRow label={t("settings.library.location")} description={<FolderPath path={dataDir} />} />;
}

function LibraryPagesGroup() {
  const { t } = useTranslation();
  return (
    <SettingsGroup title={t("settings.library.manage")}>
      {LIBRARY_PAGES.map((p) => (
        <SettingLinkRow key={p.to} to={p.to} label={t(p.labelKey)} />
      ))}
    </SettingsGroup>
  );
}

const LEVEL_LABEL: Record<FolderLevel, string> = {
  wildlifeYear: "settings.library.folderLayout.levels.wildlifeYear",
  year: "settings.library.folderLayout.levels.year",
  month: "settings.library.folderLayout.levels.month",
  date: "settings.library.folderLayout.levels.date",
  trip: "settings.library.folderLayout.levels.trip",
  country: "settings.library.folderLayout.levels.country",
  province: "settings.library.folderLayout.levels.province",
  place: "settings.library.folderLayout.levels.place",
  group: "settings.library.folderLayout.levels.group",
  order: "settings.library.folderLayout.levels.order",
  family: "settings.library.folderLayout.levels.family",
  species: "settings.library.folderLayout.levels.species",
};

const PRESET_LABEL: Record<FolderLayoutPreset | "custom", string> = {
  species: "settings.library.folderLayout.presets.species",
  taxonomy: "settings.library.folderLayout.presets.taxonomy",
  year: "settings.library.folderLayout.presets.year",
  date: "settings.library.folderLayout.presets.date",
  trip: "settings.library.folderLayout.presets.trip",
  location: "settings.library.folderLayout.presets.location",
  custom: "settings.library.folderLayout.presets.custom",
};

// The layout only affects new imports; existing files move only via the explicit "Reorganize".
function OrganizePhotosRows() {
  const { t } = useTranslation();
  const { settings, setLocal } = useSettings();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [reorganizing, setReorganizing] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Custom picked from the menu while the layout is still a preset: shows the list to edit it.
  const [editing, setEditing] = useState(false);
  const [example, setExample] = useState<{ path: string; sample: boolean } | null>(null);
  const layoutKey = settings?.folderLayout.join(",") ?? "";
  useEffect(() => {
    if (!layoutKey) return;
    let live = true;
    api
      .get(apiPath("/settings/folder-layout/example", {}, { layout: layoutKey }))
      .then((res) => live && setExample(res))
      .catch(() => live && setExample(null));
    return () => {
      live = false;
    };
  }, [layoutKey]);

  if (!settings) return null;
  const layout = settings.folderLayout;
  const preset = folderLayoutPreset(layout);
  const custom = preset === "custom" || editing;

  async function save(next: FolderLevel[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await api.put("/settings/folder-layout", { layout: next });
      setLocal({ folderLayout: res.folderLayout });
    } catch (err) {
      setError(errorMessage(err, t("settings.library.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  function choose(value: FolderLayoutPreset | "custom") {
    if (value === "custom") {
      setEditing(true);
      return;
    }
    setEditing(false);
    void save([...FOLDER_LAYOUT_PRESETS[value]]);
  }

  async function reorganizeNow() {
    const ok = await confirm({
      title: t("settings.library.reorganizeConfirm.title"),
      message: t("settings.library.reorganizeConfirm.message"),
      confirmLabel: t("settings.library.reorganize"),
    });
    if (!ok) return;
    setReorganizing(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post("/settings/reorganize-originals");
      setResult(
        t("settings.library.reorganizeResult", {
          moved: res.moved,
          total: res.total,
          skipped: res.skipped,
          failed: res.failed,
        }),
      );
    } catch (err) {
      setError(errorMessage(err, t("settings.library.reorganizeFailed")));
    } finally {
      setReorganizing(false);
    }
  }

  return (
    <>
      <SettingRow
        label={t("settings.library.folderLayout.label")}
        description={t("settings.library.folderLayout.description")}
        control={
          // Help beside the control: an InfoTip can't sit in the description's paragraph.
          <div className="flex items-center gap-2">
            <InfoTip
              align="right"
              paragraphs={[
                t("settings.library.folderLayout.details"),
                t("settings.library.folderLayout.detailsMoving"),
              ]}
            />
            <Select
              aria-label={t("settings.library.folderLayout.label")}
              value={custom ? "custom" : preset}
              disabled={saving}
              onChange={(e) => choose(e.target.value as FolderLayoutPreset | "custom")}
            >
              {(Object.keys(PRESET_LABEL) as Array<FolderLayoutPreset | "custom">).map((p) => (
                <option key={p} value={p}>
                  {t(PRESET_LABEL[p])}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        {custom && (
          <OrderedChecklist
            id="folder-level"
            options={FOLDER_LEVELS}
            selected={layout}
            disabled={saving}
            minSelected={1}
            onChange={(next) => void save(next)}
            label={(level) => t(LEVEL_LABEL[level])}
          />
        )}
        {example && (
          <p className="text-footnote text-muted">
            {t(
              example.sample ? "settings.library.folderLayout.sampleExample" : "settings.library.folderLayout.example",
            )}{" "}
            <span className="break-all font-medium text-ink">{example.path.replaceAll("\\", "/")}</span>
          </p>
        )}
      </SettingRow>
      <FileNameRow />
      <SettingRow
        label={t("settings.library.reorganizeLabel")}
        description={t("settings.library.reorganizeDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={reorganizeNow} loading={reorganizing}>
            {reorganizing ? t("settings.library.reorganizing") : t("settings.library.reorganize")}
          </Button>
        }
      >
        {(error || result) && <FormMessage error={error} success={result} />}
      </SettingRow>
    </>
  );
}
