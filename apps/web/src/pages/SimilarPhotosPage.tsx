import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../api/client";
import ManageListPage, { ManageList, RowThumb, type ManageRow } from "../components/ManageListPage";
import Button from "../components/Button";
import PhotosIcon from "../components/PhotosIcon";
import { errorMessage } from "../lib/errorMessage";
import { formatDate, formatDateSpan } from "../lib/format";
import { docsUrl } from "../lib/docs";
import { useSpeciesName } from "../lib/speciesName";
import { useApiRoute } from "../lib/resource";
import { useToast } from "../hooks/useToast";

const PAGE = 200;

// Groups of near-identical photos to review, largest first. A group opens in the Gallery, where
// it can be compared, rated, hidden or deleted; this page only lists them.
export default function SimilarPhotosPage() {
  const { t } = useTranslation();
  const speciesName = useSpeciesName();
  const res = useApiRoute(apiPath("/gallery/similar", {}, { limit: String(PAGE) }));
  const groups = res.data?.groups ?? null;
  const total = res.data?.total ?? 0;
  const [loadingMore, setLoadingMore] = useState(false);
  const toast = useToast();

  async function loadMore() {
    setLoadingMore(true);
    try {
      const more = await api.get(
        apiPath("/gallery/similar", {}, { limit: String(PAGE), offset: String(groups?.length ?? 0) }),
      );
      res.setData((prev) => prev && { total: more.total, groups: [...prev.groups, ...more.groups] });
    } catch (err) {
      toast.error(errorMessage(err, t("similar.loadFailed")));
    } finally {
      setLoadingMore(false);
    }
  }

  const rows: ManageRow[] = (groups ?? []).map((g) => {
    const sameDay = formatDate(g.firstTakenAt) === formatDate(g.lastTakenAt);
    return {
      key: g.captureId,
      to: `/gallery?similarTo=${g.captureId}`,
      primary: speciesName(g),
      secondary: sameDay
        ? `${formatDate(g.firstTakenAt, "medium")} · ${formatDate(g.firstTakenAt, "time")}`
        : formatDateSpan(g.firstTakenAt, g.lastTakenAt),
      trailing: t("similar.count", { count: g.count }),
      thumb: (
        <div className="flex gap-1">
          {g.previewPhotoIds.map((photoId, i) => (
            // One on a phone, so the name keeps its room.
            <div key={photoId} className={i >= 1 ? "hidden sm:block" : undefined}>
              <RowThumb src={`/api/photos/${photoId}/thumb`} alt="" />
            </div>
          ))}
        </div>
      ),
    };
  });

  return (
    <ManageListPage
      title={t("similar.title")}
      backLabel={t("nav.gallery")}
      backFallbackTo="/gallery"
      description={t("similar.description")}
      help={[t("similar.help.how"), t("similar.help.review"), t("similar.help.missing")]}
      docsHref={docsUrl("/guides/gallery-and-search#similar-photos")}
      loading={res.loading}
      error={res.error ? errorMessage(res.error, t("similar.loadFailed")) : null}
      onRetry={() => void res.reload()}
      isEmpty={groups?.length === 0}
      empty={{ icon: <PhotosIcon />, title: t("similar.empty.title"), description: t("similar.empty.description") }}
      wide
    >
      <p className="text-footnote text-muted">{t("similar.groups", { count: total })}</p>
      <ManageList rows={rows} label={t("similar.title")} />
      {groups && groups.length < total && (
        <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
          {t("similar.loadMore")}
        </Button>
      )}
    </ManageListPage>
  );
}
