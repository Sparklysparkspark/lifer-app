import { useState } from "react";
import { useTranslation } from "react-i18next";
import AddSpeciesListModal from "../../components/AddSpeciesListModal";
import Button from "../../components/Button";
import EmptyState from "../../components/EmptyState";
import SearchInput from "../../components/SearchInput";
import { SpeciesListRow } from "../../components/SpeciesListRows";
import { useSpeciesLists } from "../../lib/speciesLists";
import { SettingRow, SettingsGroup } from "./shared";

// Past this many lists a filter box helps find one (rule S11).
const FILTER_FROM = 8;

/** Every list added from iNaturalist, hidden ones included, with its actions. */
export default function SpeciesListsGroup() {
  const { t } = useTranslation();
  const { lists, error, reload, replace, remove } = useSpeciesLists();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const term = filter.trim().toLowerCase();
  const shown = lists?.filter((l) => !term || l.name.toLowerCase().includes(term)) ?? [];

  return (
    <SettingsGroup title={t("speciesLists.settings.title")}>
      <SettingRow
        label={t("speciesLists.settings.add")}
        description={t("speciesLists.settings.addDescription")}
        control={
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            {t("speciesLists.settings.addButton")}
          </Button>
        }
      >
        {lists && lists.length > FILTER_FROM && (
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder={t("speciesLists.settings.filter")}
            aria-label={t("speciesLists.settings.filter")}
          />
        )}
      </SettingRow>
      {error && !lists ? (
        <EmptyState
          compact
          title={t("speciesLists.settings.loadFailed")}
          error={error}
          action={{ label: t("common.retry"), onClick: () => void reload() }}
        />
      ) : (
        shown.map((l) => <SpeciesListRow key={l.id} list={l} onChanged={replace} onRemoved={remove} />)
      )}
      {term && lists && shown.length === 0 && (
        <p className="px-panel py-3 text-subheadline text-muted">
          {t("speciesLists.settings.noMatch", { query: filter.trim() })}
        </p>
      )}
      {adding && <AddSpeciesListModal onClose={() => setAdding(false)} />}
    </SettingsGroup>
  );
}
