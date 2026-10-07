import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import Button from "../../components/Button";
import EbirdImport from "../../components/EbirdImport";
import FormMessage from "../../components/FormMessage";
import { useConfirm } from "../../hooks/useConfirm";
import { useSettings } from "../../hooks/useSettings";
import { errorMessage } from "../../lib/errorMessage";
import { Card, SettingToggleCard } from "./shared";
import { useServerSetting } from "./useServerSetting";

export default function SpeciesImportSettings() {
  return (
    <>
      <SpeciesSuggestSection />
      <AnyTaxaSearchSection />
      <SpeciesNamingSection />
      <EbirdImport onImported={() => {}} />
      <HideObscureSpeciesSection />
      <TechnicalDivingSection />
    </>
  );
}

// Suggestions are computed on-device and improve as confirmed imports add the user's own photos.
function SpeciesSuggestSection() {
  const setting = useServerSetting("speciesSuggestEnabled", "/settings/species-suggest");
  const [modelDownloaded, setModelDownloaded] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get<{ downloaded: boolean; usable?: boolean }>("/settings/embedding-model/status")
      .then((res) => setModelDownloaded(res.usable ?? res.downloaded))
      .catch(() => setModelDownloaded(null));
  }, []);

  // Offloading the model turns this off server-side, so the checkbox can't claim a suggestion
  // source that doesn't exist.
  const modelMissing = modelDownloaded === false;

  return (
    <SettingToggleCard
      setting={setting}
      learnMore="species-suggestions"
      title={
        <>
          Species suggestions{" "}
          <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
            Experimental
          </span>
        </>
      }
      description="While importing photos, Lifer suggests likely species for each one based on visual similarity to your own past photos and to reference photos for that region. Nothing ever leaves your device. It gets better for you specifically over time: whenever you confirm or correct a suggestion, that photo becomes one more example it learns from."
      label="Suggest species while importing photos"
      checked={!!setting.value && !modelMissing}
      disabled={modelMissing}
    >
      {modelMissing && (
        <p className="text-sm text-muted">
          Requires the species-matching model, which isn't downloaded.{" "}
          <Link to="/settings/offline-data" className="text-accent hover:underline">
            Download it from Offline data
          </Link>{" "}
          to re-enable this.
        </p>
      )}
    </SettingToggleCard>
  );
}

// Off by default: a live iNaturalist lookup that creates species rows for taxa Lifer has no dataset for.
function AnyTaxaSearchSection() {
  const setting = useServerSetting("anyTaxaSearchEnabled", "/settings/any-taxa-search");
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <SettingToggleCard
      setting={setting}
      learnMore="any-taxa-search"
      title="Any-taxa search"
      description="Lifer doesn't have a real dataset for every taxon (insects, arachnids, plants, fungi, and more), so species tiers and occurrence data aren't offered for these. When enabled, jumping to a species with no local match offers a live iNaturalist search instead. Pick a result and a region to add it under Other Taxa on the Collection page, with its photo and description pulled from iNaturalist."
      label="Enable any-taxa search"
    >
      {setting.value && (
        <Button variant="secondary" size="sm" onClick={() => setModalOpen(true)}>
          Search iNaturalist for a species to add
        </Button>
      )}
      {modalOpen && <AddOtherTaxaModal initialQuery="" onClose={() => setModalOpen(false)} />}
    </SettingToggleCard>
  );
}

function HideObscureSpeciesSection() {
  const setting = useServerSetting("hideObscureSpecies", "/settings/hide-obscure-species");
  return (
    <SettingToggleCard
      setting={setting}
      learnMore="obscure-species"
      title="Obscure and inaccessible species"
      description="Hides deep-water fish (beyond recreational/technical diving depth) and species with almost no historical record, mostly ones nobody will realistically encounter. Anything you've already collected or seen always stays visible regardless."
      label="Hide obscure/inaccessible species from region checklists"
    />
  );
}

// Separate from the filter above because most photographers never get near 120m.
function TechnicalDivingSection() {
  const setting = useServerSetting("technicalDiving", "/settings/technical-diving");
  return (
    <SettingToggleCard
      setting={setting}
      learnMore="obscure-species"
      title="Technical diving"
      description="Recreational diving tops out around 50-60m, so that's the default range for the obscure-species filter above. Turn this on if you're technical-certified and want the deeper 120m range instead."
      label="Use technical diving depth range (120m) instead of recreational (60m)"
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
  common: 'e.g. "American Robin"',
  latin: 'e.g. "Turdus migratorius"',
  ebird_code: "6 letters, every bird worldwide",
  aba_code: "4 letters, North America/Mexico/Central America/Caribbean birds only",
  tree: 'e.g. "Aves / Passeriformes / Turdidae / Turdus migratorius"',
};

// An ordered list rather than checkboxes: the first part a species has becomes the primary name,
// the rest go in parens (see composeSpeciesName).
function SpeciesNamingSection() {
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
      const res = await api.post<{ moved: number; skipped: number; failed: number; total: number }>(
        "/settings/reorganize-originals",
      );
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
    <Card
      title="Species naming"
      learnMore="species-naming"
      description="What shows in a species' folder name and embedded photo tags: pick any combination, in any order. The first part a species actually has comes first; the rest follow in parens. eBird/ABA codes only apply to birds and are silently skipped for everything else."
    >
      <div className="flex flex-col gap-1.5 text-sm text-ink">
        {ordered.map((style) => {
          const selected = styles.includes(style);
          const selectedIdx = styles.indexOf(style);
          return (
            <div key={style} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted">
              <input type="checkbox" checked={selected} disabled={saving} onChange={() => toggle(style)} />
              <span className="flex-1">
                {NAMING_STYLE_LABEL[style]} <span className="text-xs text-muted">({NAMING_STYLE_HINT[style]})</span>
              </span>
              {selected && (
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    disabled={saving || selectedIdx === 0}
                    onClick={() => move(style, -1)}
                    className="rounded px-1 text-muted hover:bg-surface disabled:opacity-30"
                    aria-label={`Move ${NAMING_STYLE_LABEL[style]} up`}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={saving || selectedIdx === styles.length - 1}
                    onClick={() => move(style, 1)}
                    className="rounded px-1 text-muted hover:bg-surface disabled:opacity-30"
                    aria-label={`Move ${NAMING_STYLE_LABEL[style]} down`}
                  >
                    ↓
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!abaAvailable && (
          <p className="text-xs text-muted">
            ABA codes will show up here once you've downloaded a region pack covering North America, Mexico, Central
            America, or the Caribbean.
          </p>
        )}
        <p className="text-xs text-muted">
          This only changes what new photos get named. Photos already in your library keep their existing folder name
          and embedded tags until you update them.
        </p>
        <Button variant="secondary" size="sm" onClick={updateExistingPhotos} loading={updating} className="self-start">
          {updating ? "Updating…" : "Update existing photos to match"}
        </Button>
        <FormMessage error={error} success={updateResult} />
      </div>
    </Card>
  );
}
