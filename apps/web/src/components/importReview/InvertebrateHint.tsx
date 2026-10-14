import { useState } from "react";
import { useTranslation } from "react-i18next";
import AddOtherTaxaModal from "../AddOtherTaxaModal";
import type { SpeciesResult } from "../SpeciesPicker";
import { useServerSetting } from "../../pages/settings/useServerSetting";

// An insect or spider: the built-in checklists cover vertebrates, so suggestions would only be the
// nearest bird. Points to adding the species from iNaturalist instead, assigned to this photo.
export default function InvertebrateHint({
  looksLike,
  regionId,
  onPick,
}: {
  looksLike: string;
  regionId: string | null;
  onPick: (result: SpeciesResult) => void;
}) {
  const { t } = useTranslation();
  const search = useServerSetting("anyTaxaSearchEnabled", "/settings/any-taxa-search");
  const [open, setOpen] = useState(false);

  async function start() {
    // The search is a live lookup on iNaturalist, so it's opt-in; asking for it here opts in.
    if (!search.value) await search.save(true);
    setOpen(true);
  }

  return (
    <div className="mt-2 ml-7 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface-muted px-2 py-1.5 text-xs text-ink">
      <span>{t("import.invertebrate.message", { looksLike })}</span>
      <button
        onClick={() => void start()}
        disabled={search.saving}
        title={search.value ? undefined : t("import.invertebrate.searchOptIn")}
        className="ml-auto font-medium underline disabled:opacity-50"
      >
        {t("import.invertebrate.search")}
      </button>
      {search.error && <span className="w-full text-rose-700 dark:text-rose-300">{search.error}</span>}
      {open && (
        <AddOtherTaxaModal initialQuery="" initialRegionId={regionId} onAdded={onPick} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
