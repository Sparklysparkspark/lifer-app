import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import Button from "../../components/Button";
import EbirdImportRow from "./EbirdImportRow";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import { SettingRow, SettingSwitchRow, SettingsGroup } from "./shared";
import { useServerSetting } from "./useServerSetting";

export default function SpeciesImportSettings() {
  return (
    <>
      <SettingsGroup title="Identification">
        <SpeciesSuggestRow />
        <InatSearchRows />
      </SettingsGroup>
      <SettingsGroup title="Species names">
        <SpeciesNamingRows />
      </SettingsGroup>
      <SettingsGroup title="Checklists">
        <HideObscureSpeciesRow />
        <TechnicalDivingRow />
        <EbirdImportRow />
      </SettingsGroup>
    </>
  );
}

// Suggestions are computed on-device and improve as confirmed imports add the user's own photos.
function SpeciesSuggestRow() {
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
      label="Suggest species while importing"
      description={
        modelMissing ? (
          <>
            Needs the species-matching model.{" "}
            <Link to="/settings/offline-data" className="underline hover:text-ink">
              Download it in Offline data
            </Link>
            .
          </>
        ) : (
          "Matches each photo against your own photos and reference photos, on this device."
        )
      }
      checked={!!setting.value && !modelMissing}
      disabled={modelMissing}
    />
  );
}

// Off by default: a live iNaturalist lookup that creates species rows for taxa Lifer has no dataset for.
function InatSearchRows() {
  const setting = useServerSetting("anyTaxaSearchEnabled", "/settings/any-taxa-search");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <SettingSwitchRow
        setting={setting}
        label="Search iNaturalist for other species"
        description="For insects, plants, fungi and anything else Lifer's lists don't cover. Sends your search to iNaturalist."
      />
      {setting.value && (
        <SettingRow
          label="Add a species from iNaturalist"
          control={
            <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
              Search
            </Button>
          }
        />
      )}
      {modalOpen && <AddOtherTaxaModal initialQuery="" onClose={() => setModalOpen(false)} />}
    </>
  );
}

function HideObscureSpeciesRow() {
  const setting = useServerSetting("hideObscureSpecies", "/settings/hide-obscure-species");
  return (
    <SettingSwitchRow
      setting={setting}
      label="Hide obscure species"
      description="Deep-water fish and species with almost no records. Ones you've seen always show."
    />
  );
}

// Separate from the filter above because most photographers never get near 120m.
function TechnicalDivingRow() {
  const setting = useServerSetting("technicalDiving", "/settings/technical-diving");
  return (
    <SettingSwitchRow
      setting={setting}
      label="Technical diving depths"
      description="Counts fish down to 120m as reachable, instead of 60m."
    />
  );
}

// ABA codes only cover birds in North America, Mexico, Central America and the Caribbean; eBird
// codes cover every bird. A species without the chosen code falls back to its common name.
type NamingStyle = "common" | "latin" | "ebird_code" | "aba_code" | "tree";

const NAMING_STYLE_LABEL: Record<NamingStyle, string> = {
  common: "Common name",
  latin: "Scientific (Latin) name",
  ebird_code: "eBird code",
  aba_code: "ABA code",
  tree: "Full taxonomy tree",
};

const NAMING_STYLE_HINT: Record<NamingStyle, string> = {
  common: "American Robin",
  latin: "Turdus migratorius",
  ebird_code: "amerob, birds only",
  aba_code: "AMRO, North and Central American birds",
  tree: "Aves / Passeriformes / Turdidae / Turdus migratorius",
};

// An ordered list rather than checkboxes: the first part a species has becomes the primary name,
// the rest go in parens (see composeSpeciesName).
function SpeciesNamingRows() {
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
      setError(errorMessage(err, "Couldn't update this setting"));
    } finally {
      setSaving(false);
    }
  }

  // The style only affects new photos; this reuses Library's reorganize endpoint to rename
  // existing folders and refresh embedded tags.
  async function updateExistingPhotos() {
    const ok = await confirm({
      title: "Update existing photos?",
      message: "This renames existing photo folders and refreshes embedded tags to match your current naming style.",
      confirmLabel: "Update photos",
    });
    if (!ok) return;
    setUpdating(true);
    setError(null);
    setUpdateResult(null);
    try {
      const res = await api.post("/settings/reorganize-originals");
      setUpdateResult(
        `Updated ${res.moved} of ${res.total} photos to match (${res.skipped} already matched, ${res.failed} failed).`,
      );
    } catch (err) {
      setError(errorMessage(err, "Couldn't update your existing photos"));
    } finally {
      setUpdating(false);
    }
  }

  function toggle(style: NamingStyle) {
    void apply(styles.includes(style) ? styles.filter((s) => s !== style) : [...styles, style]);
  }

  function move(style: NamingStyle, direction: -1 | 1) {
    const i = styles.indexOf(style);
    const j = i + direction;
    if (i < 0 || j < 0 || j >= styles.length) return;
    const next = [...styles];
    [next[i], next[j]] = [next[j], next[i]];
    void apply(next);
  }

  const available: NamingStyle[] = [
    "common",
    "latin",
    "ebird_code",
    "tree",
    ...(abaAvailable ? (["aba_code"] as const) : []),
  ];
  // Selected first in their real order, since only those are reorderable.
  const ordered = [...styles, ...available.filter((s) => !styles.includes(s))];

  return (
    <>
      <SettingRow
        label="Name format"
        description="For species folders and photo tags. The first part a species has leads; the rest follow in brackets."
      >
        <ul>
          {ordered.map((style) => {
            const selected = styles.includes(style);
            const selectedIdx = styles.indexOf(style);
            return (
              <li key={style} className="flex items-center gap-2 py-1 text-sm text-ink">
                <input
                  type="checkbox"
                  id={`naming-${style}`}
                  checked={selected}
                  disabled={saving}
                  onChange={() => toggle(style)}
                  className="accent-accent"
                />
                <label htmlFor={`naming-${style}`} className="flex-1">
                  {NAMING_STYLE_LABEL[style]} <span className="text-xs text-muted">{NAMING_STYLE_HINT[style]}</span>
                </label>
                {selected && (
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={saving || selectedIdx === 0}
                      onClick={() => move(style, -1)}
                      className="rounded px-1 text-muted hover:text-ink disabled:opacity-30"
                      aria-label={`Move ${NAMING_STYLE_LABEL[style]} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={saving || selectedIdx === styles.length - 1}
                      onClick={() => move(style, 1)}
                      className="rounded px-1 text-muted hover:text-ink disabled:opacity-30"
                      aria-label={`Move ${NAMING_STYLE_LABEL[style]} down`}
                    >
                      ↓
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {!abaAvailable && (
          <p className="text-xs text-muted">ABA codes appear once you download a North or Central American pack.</p>
        )}
      </SettingRow>
      <SettingRow
        label="Rename existing photos"
        description="New photos use the format above; this updates folders and tags already in your library."
        control={
          <Button variant="secondary" size="sm" onClick={updateExistingPhotos} loading={updating}>
            {updating ? "Updating…" : "Update photos"}
          </Button>
        }
      >
        {(error || updateResult) && <FormMessage error={error} success={updateResult} />}
      </SettingRow>
    </>
  );
}
