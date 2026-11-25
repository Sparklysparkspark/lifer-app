import { useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { taxonDisplayLabel, type TaxonClass } from "@lifer/shared";
import { api } from "../../api/client";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import Checkbox from "../../components/Checkbox";
import FreeSpaceNote from "../../components/FreeSpaceNote";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatBytes, formatList } from "../../lib/format";
import { markPackDownloadStarted, refreshPackDownload } from "../../lib/packDownloadStore";
import type { CountryGroup, DownloadVariant, RemoteState } from "../../lib/packIndex";
import PackVariantControl from "../offlinePacks/PackVariantControl";
import ConnectionNote, { ListLoadingNote } from "../../components/ConnectionNote";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";

// Past this many countries the title gives a count and the names go in the body.
const NAMED_IN_TITLE = 3;

/** "Download species lists" from the Collection's Add species menu: the groups the countries in
 *  view are missing, nothing chosen until the user picks. Download starts in the background and
 *  the dialog closes at once; progress shows in the StatusTray. */
export default function AddGroupsModal({
  countryNames,
  groups,
  freeBytes,
  connection = "online",
  listReady = true,
  listProgress = null,
  sizesPending = false,
  onlyDownloaded,
  namingStyles,
  onClose,
}: {
  countryNames: string[];
  groups: CountryGroup[];
  freeBytes: number | null;
  /** Offline turns Download off; slow only says so, since a download just takes longer. */
  connection?: RemoteState;
  /** False while the list of downloadable groups is still on its way: what's downloaded shows,
   *  the rest fills in when it lands, and Download waits for it. */
  listReady?: boolean;
  /** How far that list has got. */
  listProgress?: { receivedBytes: number; totalBytes: number | null } | null;
  /** Sizes don't include photos yet: no size shows rather than a too-small one. */
  sizesPending?: boolean;
  /** A continent or the world: only its downloaded countries are offered, which the dialog says. */
  onlyDownloaded: boolean;
  namingStyles: string[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<TaxonClass>>(new Set());
  // Full by default, as on the Species downloads page.
  const [variant, setVariant] = useState<DownloadVariant>("full");
  const missing = groups.filter((g) => !g.downloaded);
  const bytes = missing.reduce((sum, g) => (chosen.has(g.taxon) ? sum + g.sizeBytes[variant] : sum), 0);
  const named = countryNames.length <= NAMED_IN_TITLE;

  function toggle(taxon: TaxonClass, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(taxon);
      else next.delete(taxon);
      return next;
    });
  }

  function download() {
    // In picker order, which download-batch also queues by.
    const taxa = missing.map((g) => g.taxon).filter((taxon) => chosen.has(taxon));
    onClose();
    api
      .post("/offline-packs/download-batch", { regionNames: countryNames, taxa, variant })
      .then((res) => {
        markPackDownloadStarted();
        void refreshPackDownload();
        if (res.queued != null) toast.info(t("offlinePacks.selection.queued", { count: res.queued }));
      })
      .catch((err) => toast.error(errorMessage(err, t("offlinePacks.download.startFailed"))));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        named
          ? t("collection.addGroups.title", { countries: formatList(countryNames) })
          : t("collection.addGroups.titleCount", { count: countryNames.length })
      }
      description={!named ? formatList(countryNames) : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={download} disabled={!listReady || connection === "offline" || chosen.size === 0}>
            {t("collection.addGroups.download")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {groups.map((g) => (
            <Checkbox
              key={g.taxon}
              checked={g.downloaded || chosen.has(g.taxon)}
              disabled={g.downloaded}
              onChange={(on) => toggle(g.taxon, on)}
              description={
                g.downloaded
                  ? t("collection.addGroups.downloaded")
                  : sizesPending
                    ? undefined
                    : formatBytes(g.sizeBytes[variant])
              }
            >
              {taxonDisplayLabel(g.taxon, namingStyles)}
            </Checkbox>
          ))}
        </div>
        {!listReady ? (
          connection === "offline" ? (
            <ConnectionNote state="offline" />
          ) : (
            <ListLoadingNote progress={listProgress} />
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {missing.length > 0 && <PackVariantControl value={variant} onChange={setVariant} />}
              {/* Narrow, the summary wraps below the control rather than squeezing beside it. */}
              <p className="min-w-56 flex-1 text-callout text-muted">
                {missing.length === 0 ? (
                  t("collection.addGroups.allDownloaded")
                ) : chosen.size === 0 ? (
                  t("collection.addGroups.chooseOne")
                ) : sizesPending ? (
                  t("collection.addGroups.summaryNoSize", { count: chosen.size })
                ) : (
                  <>
                    {t("collection.addGroups.summary", { count: chosen.size, size: formatBytes(bytes) })}
                    <FreeSpaceNote needed={bytes} free={freeBytes} />
                  </>
                )}
              </p>
            </div>
            <ConnectionNote state={connection} />
          </>
        )}
        <p className="text-footnote text-muted">
          <Trans
            i18nKey={onlyDownloaded ? "collection.addGroups.onlyDownloaded" : "collection.addGroups.otherCountries"}
            // Not <link>: an HTML void tag, which Trans closes at once.
            components={{
              more: (
                <Link to={SPECIES_DOWNLOADS_PATH} state={{ backLabel: t("nav.collection") }} className="underline" />
              ),
            }}
          />
        </p>
      </div>
    </Modal>
  );
}
