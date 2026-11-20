import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api/client";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import Button from "../../components/Button";
import EbirdImportRow from "./EbirdImportRow";
import TargetListsRow from "./TargetListsRow";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import { SettingLinkRow, SettingRow, SettingSwitchRow, SettingsGroup } from "./shared";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";
import OrderedChecklist from "./OrderedChecklist";
import PhotoVersionsSettings from "./PhotoVersionsSettings";
import { useServerSetting } from "./useServerSetting";

export default function SpeciesImportSettings() {
  const { t } = useTranslation();
  return (
    <>
      {/* First, since it's where every checklist comes from. */}
      <SettingsGroup title={t("settings.groups.regions")}>
        <SettingLinkRow
          to={SPECIES_DOWNLOADS_PATH}
          label={t("settings.downloads.open")}
          description={t("settings.downloads.openDescription")}
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.species.identification")}>
        <SpeciesSuggestRow />
        <InatSearchRows />
      </SettingsGroup>
      <SettingsGroup title={t("settings.species.names")}>
        <SpeciesNamingRows />
      </SettingsGroup>
      <SettingsGroup title={t("settings.species.checklists")}>
        <HideObscureSpeciesRow />
        <TechnicalDivingRow />
        <EbirdImportRow />
        <TargetListsRow />
      </SettingsGroup>
      <PhotoVersionsSettings />
    </>
  );
}

// Suggestions are computed on-device and improve as confirmed imports add the user's own photos.
function SpeciesSuggestRow() {
  const { t } = useTranslation();
  const setting = useServerSetting("speciesSuggestEnabled", "/settings/species-suggest");
  const [modelDownloaded, setModelDownloaded] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get("/settings/embedding-model/status")
      .then((res) => setModelDownloaded(res.usable ?? res.downloaded))
      .catch(() => setModelDownloaded(null));
  }, []);

  // Offloading the model turns this off server-side, so the switch can't claim a suggestion
  // source that doesn't exist.
  const modelMissing = modelDownloaded === false;

  return (
    <SettingSwitchRow
      setting={setting}
      label={t("settings.species.suggest")}
      description={
        modelMissing ? (
          <Trans
            i18nKey="settings.species.suggestNeedsModel"
            components={{ a: <Link to="/settings/offline-data" className="underline hover:text-ink" /> }}
          />
        ) : (
          t("settings.species.suggestDescription")
        )
      }
      checked={!!setting.value && !modelMissing}
      disabled={modelMissing}
    />
  );
}

// Off by default: a live iNaturalist lookup that creates species rows for taxa Lifer has no dataset for.
function InatSearchRows() {
  const { t } = useTranslation();
  const setting = useServerSetting("anyTaxaSearchEnabled", "/settings/any-taxa-search");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <SettingSwitchRow
        setting={setting}
        label={t("settings.species.inatSearch")}
        description={t("settings.species.inatSearchDescription")}
      />
      {setting.value && (
        <SettingRow
          label={t("settings.species.inatAdd")}
          description={t("settings.species.inatAddDescription")}
          control={
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
              {t("settings.species.search")}
            </Button>
          }
        />
      )}
      {modalOpen && <AddOtherTaxaModal initialQuery="" onClose={() => setModalOpen(false)} />}
    </>
  );
}

function HideObscureSpeciesRow() {
  const { t } = useTranslation();
  const setting = useServerSetting("hideObscureSpecies", "/settings/hide-obscure-species");
  return (
    <SettingSwitchRow
      setting={setting}
      label={t("settings.species.hideObscure")}
      description={t("settings.species.hideObscureDescription")}
    />
  );
}

// Separate from the filter above because most photographers never get near 120m.
function TechnicalDivingRow() {
  const { t } = useTranslation();
  const setting = useServerSetting("technicalDiving", "/settings/technical-diving");
  return (
    <SettingSwitchRow
      setting={setting}
      label={t("settings.species.technicalDiving")}
      description={t("settings.species.technicalDivingDescription")}
    />
  );
}

// ABA codes only cover birds in North America, Mexico, Central America and the Caribbean; eBird
// codes cover every bird. A species without the chosen code falls back to its common name.
type NamingStyle = "common" | "latin" | "ebird_code" | "aba_code" | "tree";

const NAMING_STYLE_LABEL: Record<NamingStyle, string> = {
  common: "settings.species.naming.common",
  latin: "settings.species.naming.latin",
  ebird_code: "settings.species.naming.ebirdCode",
  aba_code: "settings.species.naming.abaCode",
  tree: "settings.species.naming.tree",
};

const NAMING_STYLE_HINT: Record<NamingStyle, string> = {
  common: "settings.species.naming.commonHint",
  latin: "settings.species.naming.latinHint",
  ebird_code: "settings.species.naming.ebirdCodeHint",
  aba_code: "settings.species.naming.abaCodeHint",
  tree: "settings.species.naming.treeHint",
};

// An ordered list rather than checkboxes: the first part a species has becomes the primary name,
// the rest go in parens (see composeSpeciesName).
function SpeciesNamingRows() {
  const { t } = useTranslation();
  const { settings, setLocal } = useSettings();
  const confirm = useConfirm();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateResult, setUpdateResult] = useState<string | null>(null);

  if (!settings) return null;
  const styles: NamingStyle[] =
    settings.speciesNamingStyles.length > 0 ? (settings.speciesNamingStyles as NamingStyle[]) : ["common"];
  const abaAvailable = settings.abaCodesAvailable;

  async function apply(next: NamingStyle[]) {
    setSaving(true);
    setError(null);
    setUpdateResult(null);
    try {
      await api.put("/settings/species-naming-style", { styles: next });
      setLocal({ speciesNamingStyles: next });
    } catch (err) {
      setError(errorMessage(err, t("settings.species.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  // The style only affects new photos; this reuses Library's reorganize endpoint to rename
  // existing folders and refresh embedded tags.
  async function updateExistingPhotos() {
    const ok = await confirm({
      title: t("settings.species.updateConfirm.title"),
      message: t("settings.species.updateConfirm.message"),
      confirmLabel: t("settings.species.updatePhotos"),
    });
    if (!ok) return;
    setUpdating(true);
    setError(null);
    setUpdateResult(null);
    try {
      const res = await api.post("/settings/reorganize-originals");
      setUpdateResult(
        t("settings.species.updateResult", {
          moved: res.moved,
          total: res.total,
          skipped: res.skipped,
          failed: res.failed,
        }),
      );
    } catch (err) {
      setError(errorMessage(err, t("settings.species.updateFailed")));
    } finally {
      setUpdating(false);
    }
  }

  const available: NamingStyle[] = [
    "common",
    "latin",
    "ebird_code",
    "tree",
    ...(abaAvailable ? (["aba_code"] as const) : []),
  ];

  return (
    <>
      <SettingRow label={t("settings.species.nameFormat")} description={t("settings.species.nameFormatDescription")}>
        <OrderedChecklist
          id="naming"
          options={available}
          selected={styles}
          disabled={saving}
          onChange={(next) => void apply(next)}
          label={(style) => t(NAMING_STYLE_LABEL[style])}
          hint={(style) => t(NAMING_STYLE_HINT[style])}
        />
        {!abaAvailable && <p className="text-footnote text-muted">{t("settings.species.abaHint")}</p>}
      </SettingRow>
      <SettingRow
        label={t("settings.species.rename")}
        description={t("settings.species.renameDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={updateExistingPhotos} loading={updating}>
            {updating ? t("settings.species.updating") : t("settings.species.updatePhotos")}
          </Button>
        }
      >
        {(error || updateResult) && <FormMessage error={error} success={updateResult} />}
      </SettingRow>
    </>
  );
}
