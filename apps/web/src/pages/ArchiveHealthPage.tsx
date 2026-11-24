import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commonFolder } from "@lifer/shared";
import { api, apiPath } from "../api/client";
import Button from "../components/Button";
import FolderPath from "../components/FolderPath";
import MovedFolderSuggestion from "../components/MovedFolderSuggestion";
import ManageListPage, { ManageList, RowThumb, type ManageMenuItem } from "../components/ManageListPage";
import { useRevealOriginal } from "../hooks/useRevealOriginal";
import { useToast } from "../hooks/useToast";
import { useConfirm } from "../hooks/useConfirm";
import { docsUrl } from "../lib/docs";
import { formatNumber } from "../lib/format";
import { useSpeciesName } from "../lib/speciesName";

type Problems = Awaited<ReturnType<typeof loadProblems>>;
type Problem = Problems["items"][number];

const loadProblems = () => api.get("/originals/health/problems");

// Settings > Storage > the files archive health flagged: changed without an edit, unreadable, or
// missing. Each can be revealed (when it's still there) or ignored.
export default function ArchiveHealthPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const speciesName = useSpeciesName();
  const revealFor = useRevealOriginal();
  const [data, setData] = useState<Problems | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState("");
  const confirm = useConfirm();
  const [ignoringAll, setIgnoringAll] = useState(false);

  function fetchProblems() {
    loadProblems()
      .then(setData)
      .catch(() => setLoadError(true));
  }
  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchProblems();
  }
  useEffect(fetchProblems, []);

  async function ignoreOne(item: Problem) {
    setData((d) => d && { total: d.total - 1, items: d.items.filter((i) => i.id !== item.id) });
    try {
      await api.post(apiPath("/originals/{id}/health/ignore", { id: item.id }), {});
    } catch {
      toast.error(t("archiveHealth.ignoreFailed"));
      load();
    }
  }

  // Every problem, including any past the list's limit, so the count is the total.
  async function ignoreAll() {
    if (!data) return;
    const count = data.total;
    const ok = await confirm({
      title: t("archiveHealth.ignoreAllConfirm.title", { count, total: formatNumber(count) }),
      message: t("archiveHealth.ignoreAllConfirm.message"),
      confirmLabel: t("archiveHealth.ignoreAll"),
    });
    if (!ok) return;
    setIgnoringAll(true);
    try {
      const res = await api.post("/originals/health/ignore-all");
      toast.success(t("archiveHealth.ignoredAll", { count: res.ignored, total: formatNumber(res.ignored) }));
    } catch {
      toast.error(t("archiveHealth.ignoreAllFailed"));
    } finally {
      setIgnoringAll(false);
      load();
    }
  }

  const problemLabel: Record<Problem["problem"], string> = {
    changed: t("archiveHealth.problem.changed"),
    unreadable: t("archiveHealth.problem.unreadable"),
    missing: t("archiveHealth.problem.missing"),
  };

  const shown = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!data || !query) return data?.items ?? [];
    return data.items.filter(
      (i) =>
        i.path.toLowerCase().includes(query) ||
        (i.commonName ?? "").toLowerCase().includes(query) ||
        (i.scientificName ?? "").toLowerCase().includes(query),
    );
  }, [data, search]);

  // Missing files that were all in one folder: most likely that folder moved.
  const missingFolder = useMemo(
    () => commonFolder((data?.items ?? []).filter((i) => i.problem === "missing").map((i) => i.path)),
    [data],
  );

  const title = t("archiveHealth.title");
  return (
    <ManageListPage
      title={title}
      backLabel={t("nav.settings")}
      description={t("archiveHealth.description")}
      docsHref={docsUrl("/settings#archive-health")}
      search={{ value: search, onChange: setSearch, placeholder: t("archiveHealth.searchPlaceholder") }}
      actions={
        <Button variant="secondary" size="sm" onClick={() => void ignoreAll()} loading={ignoringAll}>
          {t("archiveHealth.ignoreAll")}
        </Button>
      }
      loading={!data && !loadError}
      error={loadError ? t("archiveHealth.loadFailed") : null}
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
            <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        ),
        title: t("archiveHealth.empty.title"),
        description: t("archiveHealth.empty.description"),
      }}
      noMatch={shown.length === 0 ? t("archiveHealth.noMatch", { search }) : null}
    >
      {data && data.total > data.items.length && (
        <p className="text-subheadline text-muted">
          {t("archiveHealth.showingFirst", {
            shown: formatNumber(data.items.length),
            total: formatNumber(data.total),
          })}
        </p>
      )}
      {missingFolder && <MovedFolderSuggestion folder={missingFolder} />}
      <ManageList
        label={title}
        rows={shown.map((item) => {
          const reveal = revealFor(item.path);
          const menu: ManageMenuItem[] = [];
          // A missing file has nothing to reveal, though its path can still be copied.
          if (reveal && (reveal.kind === "copy" || item.problem !== "missing"))
            menu.push({ label: reveal.label, onSelect: reveal.run });
          menu.push({ label: t("archiveHealth.ignore"), onSelect: () => void ignoreOne(item) });
          return {
            key: item.id,
            thumb: <RowThumb src={item.photoId ? `/api/photos/${item.photoId}/thumb` : null} alt="" />,
            primary: <FolderPath path={item.path} />,
            // The problem leads the second line, so a narrow window keeps it in view.
            secondary: [
              problemLabel[item.problem],
              item.scientificName && speciesName({ commonName: item.commonName, scientificName: item.scientificName }),
            ]
              .filter(Boolean)
              .join(" · "),
            menu,
          };
        })}
      />
    </ManageListPage>
  );
}
