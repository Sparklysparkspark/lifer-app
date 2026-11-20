import { Trans, useTranslation } from "react-i18next";
import Button from "../../components/Button";
import EditableTextField from "../../components/EditableTextField";
import InfoTip from "../../components/InfoTip";
import type { TripDetail, TripFolder, TripSummary } from "./types";

const RELOCATE_INFO_PARAGRAPHS = ["trips.header.relocateInfo", "trips.header.relocateInfoDetail"];
const COUNT = { n: <span className="font-medium text-ink" /> };

// Under the trip's name: its folders, the photo count, what was notable, and the description.
export default function TripHeaderDetails({
  trip,
  photoCount,
  summary,
  onRelocate,
  onSaveDescription,
}: {
  trip: TripDetail;
  photoCount: number;
  summary: TripSummary | null;
  onRelocate: (which: TripFolder) => void;
  onSaveDescription: (description: string) => void;
}) {
  const { t } = useTranslation();
  const relocateSource = () => onRelocate("sourceFolder");
  // A started trip saves into its own folder, so one line covers both, and moving its files is in
  // the ⋯ menu. A trip made from a folder can point that folder somewhere else here.
  const separateSource = trip.destinationFolder !== trip.sourceFolder;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 text-footnote text-muted">
        <span className="shrink-0">{t("trips.header.tripFolder")}</span>
        <span className="min-w-0 truncate" title={trip.sourceFolder}>
          {trip.sourceFolder}
        </span>
        {separateSource && (
          <>
            <Button variant="link" size="sm" onClick={relocateSource} className="shrink-0">
              {t("trips.header.relocate")}
            </Button>
            <InfoTip paragraphs={RELOCATE_INFO_PARAGRAPHS.map((key) => t(key))} className="shrink-0" />
          </>
        )}
        <span className="shrink-0">· {t("trips.header.photoCount", { count: photoCount })}</span>
      </div>
      {separateSource && (
        <div className="flex min-w-0 items-center gap-2 text-footnote text-muted">
          <span className="shrink-0">{t("trips.header.savedTo")}</span>
          <span className="min-w-0 truncate" title={trip.destinationFolder}>
            {trip.destinationFolder}
          </span>
        </div>
      )}
      {summary && summary.speciesCount > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-footnote text-muted">
          <span>
            <Trans i18nKey="trips.header.species" values={{ count: summary.speciesCount }} components={COUNT} />
          </span>
          {summary.liferCount > 0 && (
            <span>
              <Trans i18nKey="trips.header.lifers" values={{ count: summary.liferCount }} components={COUNT} />
            </span>
          )}
          {summary.rareCount > 0 && (
            <span>
              <Trans i18nKey="trips.header.rare" values={{ count: summary.rareCount }} components={COUNT} />
            </span>
          )}
          {summary.endemicCount > 0 && (
            <span>
              <Trans i18nKey="trips.header.endemic" values={{ count: summary.endemicCount }} components={COUNT} />
            </span>
          )}
        </div>
      )}
      <div className="mt-2 w-full">
        <EditableTextField
          value={trip.description ?? ""}
          onSave={onSaveDescription}
          placeholder={t("trips.header.descriptionPlaceholder")}
          className="text-callout text-ink"
          multiline
        />
      </div>
    </>
  );
}
