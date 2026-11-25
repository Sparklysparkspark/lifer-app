import { useTranslation } from "react-i18next";
import Panel from "../../components/Panel";
import { SpeciesListRow } from "../../components/SpeciesListRows";
import { useSpeciesLists } from "../../lib/speciesLists";

/** Lists still being added to this region (or still fetching photos), above its species. Once a
 *  list is complete it leaves here and lives in Settings, as does a hidden one. */
export default function SpeciesListsStatus({ regionId }: { regionId: string }) {
  const { t } = useTranslation();
  const { lists, replace, remove } = useSpeciesLists();
  const shown =
    lists?.filter(
      (l) => l.regionId === regionId && !l.hidden && (l.status !== "done" || l.photosReady < l.addedCount),
    ) ?? [];
  if (shown.length === 0) return null;
  return (
    <section aria-label={t("speciesLists.collection.label")}>
      {/* A few rows show whole; many scroll inside the panel so the species stay in reach (rule S11). */}
      <Panel grouped className="max-h-72 overflow-y-auto">
        {shown.map((l) => (
          <SpeciesListRow key={l.id} list={l} onChanged={replace} onRemoved={remove} />
        ))}
      </Panel>
    </section>
  );
}
