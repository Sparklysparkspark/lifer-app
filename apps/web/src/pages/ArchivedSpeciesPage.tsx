import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ApiResponse } from "../api/client";
import ManageListPage, { ManageList, RowThumb } from "../components/ManageListPage";
import { docsUrl } from "../lib/docs";
import { useToast } from "../hooks/useToast";
import { useSpeciesName } from "../lib/speciesName";

const ARCHIVED_INFO_PARAGRAPH_KEYS = ["archivedSpecies.info.notCounted", "archivedSpecies.info.countAll"];

type ArchiveResponse = ApiResponse<"/archive">;
// Species with no family sort and group together under this.
const OTHER = "Other";

// Archived species never show in the collection or checklists, so this is the one place to see
// them again and unarchive, one at a time or a whole family at once from its heading.
export default function ArchivedSpeciesPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const [data, setData] = useState<ArchiveResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const toast = useToast();

  // A refetch after an unarchive keeps the current list up instead of flashing a spinner.
  function fetchArchive() {
    api
      .get("/archive")
      .then(setData)
      .catch(() => setLoadError(true));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchArchive();
  }

  useEffect(fetchArchive, []);

  // Sorted by family then name, so each family's rows run together under its heading.
  const visibleItems = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    const items = query
      ? data.items.filter(
          (i) =>
            (i.commonName ?? "").toLowerCase().includes(query) ||
            i.scientificName.toLowerCase().includes(query) ||
            (i.family ?? "").toLowerCase().includes(query),
        )
      : data.items;
    return [...items].sort(
      (a, b) => (a.family ?? OTHER).localeCompare(b.family ?? OTHER) || speciesName(a).localeCompare(speciesName(b)),
    );
  }, [data, search, speciesName]);

  async function unarchiveOne(speciesId: string) {
    setBusyIds((prev) => new Set(prev).add(speciesId));
    try {
      await api.delete("/archive/bulk", { speciesIds: [speciesId] });
      announceUnarchived([speciesId]);
    } catch {
      toast.error(t("archivedSpecies.countAgainFailed"));
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev);
        next.delete(speciesId);
        return next;
      });
      load();
    }
  }

  // Unarchiving is reversible, so it acts at once and offers Undo.
  function announceUnarchived(speciesIds: string[]) {
    const undo = () =>
      api
        .post("/archive/bulk", { speciesIds })
        .catch(() => toast.error(t("archivedSpecies.undoFailed")))
        .finally(load);
    toast.show(t("archivedSpecies.unarchivedToast", { count: speciesIds.length }), {
      actions: [{ label: t("common.undo"), onClick: undo }],
    });
  }

  // Only the species shown under that family: a search narrows what this touches.
  async function unarchiveFamily(family: string) {
    const speciesIds = visibleItems.filter((i) => (i.family ?? OTHER) === family).map((i) => i.speciesId);
    try {
      await api.delete("/archive/bulk", { speciesIds });
      announceUnarchived(speciesIds);
    } catch {
      toast.error(t("archivedSpecies.countGroupFailed"));
    } finally {
      load();
    }
  }

  const title = t("archivedSpecies.title");
  return (
    <ManageListPage
      title={title}
      backLabel={t("nav.settings")}
      description={t("archivedSpecies.description")}
      help={ARCHIVED_INFO_PARAGRAPH_KEYS.map((key) => t(key))}
      docsHref={docsUrl("/guides/collection-and-checklists#undoing-hide-and-archive")}
      search={{ value: search, onChange: setSearch, placeholder: t("archivedSpecies.searchPlaceholder") }}
      loading={!data}
      error={loadError ? t("archivedSpecies.loadFailed") : null}
      onRetry={load}
      isEmpty={data?.items.length === 0}
      empty={{
        icon: (
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6 text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
            <path d="M4.5 9v9A1.5 1.5 0 0 0 6 19.5h12A1.5 1.5 0 0 0 19.5 18V9" />
            <path d="M10 13h4" />
          </svg>
        ),
        title: t("archivedSpecies.empty.title"),
        description: t("archivedSpecies.empty.description"),
      }}
      noMatch={visibleItems.length === 0 ? t("archivedSpecies.noMatch", { search }) : null}
    >
      <ManageList
        label={title}
        sectionMenu={(family) => [
          { label: t("archivedSpecies.countAll.confirm"), onSelect: () => void unarchiveFamily(family) },
        ]}
        rows={visibleItems.map((item) => ({
          key: item.speciesId,
          section: item.family ?? OTHER,
          thumb: <RowThumb src={item.referenceThumbUrl ?? item.referencePhoto} alt="" />,
          primary: speciesName(item),
          secondary: <i>{item.scientificName}</i>,
          to: `/species/${item.speciesId}`,
          linkState: { backLabel: title },
          menu: [
            {
              label: busyIds.has(item.speciesId) ? t("common.saving") : t("archivedSpecies.countAgain"),
              disabled: busyIds.has(item.speciesId),
              onSelect: () => void unarchiveOne(item.speciesId),
            },
          ],
        }))}
      />
    </ManageListPage>
  );
}
