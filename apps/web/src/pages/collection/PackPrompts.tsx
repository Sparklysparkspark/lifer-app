import { useEffect, useMemo, useRef, useState } from "react";
import type { PackStatusEntry } from "../../lib/packIndex";
import { useLatest } from "../../hooks/useLatest";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { formatBytes } from "../../lib/format";
import { useConnection, usePackIndex } from "../../lib/packIndex";
import ConnectionNote from "../../components/ConnectionNote";
import FreeSpaceNote from "../../components/FreeSpaceNote";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import JobProgress from "../../components/JobProgress";
import Button from "../../components/Button";
import { usePackDownloadJob } from "../../hooks/usePackDownloadStatus";
import PackProgress from "../../components/PackProgress";
import { isOtherTaxaFilter, taxonFilterLabel, type TaxonFilter } from "./taxonLabels";
import Panel from "../../components/Panel";
import { SPECIES_DOWNLOADS_PATH } from "../../lib/speciesDownloads";

const CANCEL_URL = "/offline-packs/download/cancel";
const NO_ZONES: Array<{ id: string; name: string }> = [];

// Starts a pack download and follows the shared job. onDone fires when a download started from
// here finishes cleanly; the error or cancelled state stays on screen otherwise.
function usePackDownloadAndWait(onDone: (packIds: string[]) => void) {
  const startedIds = useRef<string[] | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const onDoneRef = useLatest(onDone);
  const job = usePackDownloadJob({
    onFinish: (status) => {
      const ids = startedIds.current;
      if (!ids) return;
      startedIds.current = null;
      if (!status.error && !status.cancelled) onDoneRef.current(ids);
    },
  });
  async function download(packIds: string[]) {
    setStartedHere(true);
    startedIds.current = packIds;
    const ok = await job.start("/offline-packs/download", { packIds });
    if (!ok) startedIds.current = null;
  }
  const running = !!job.status?.running;
  return { job, download, running, startedHere };
}

function DownloadProgress({ job }: { job: ReturnType<typeof usePackDownloadJob> }) {
  return (
    <div className="mx-auto mt-4 max-w-sm text-left">
      <PackProgress
        status={job.status}
        onCancel={(downloadsOnly) => void job.cancel(CANCEL_URL, downloadsOnly ? { downloadsOnly } : undefined)}
        cancelling={job.cancelling}
      />
    </div>
  );
}

function DownloadOutcome({ job, startedHere }: { job: ReturnType<typeof usePackDownloadJob>; startedHere: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto mt-2 max-w-sm text-left">
      <JobProgress
        status={startedHere ? job.status : null}
        error={job.actionError}
        errorPrefix={t("collection.packPrompt.regionFailed")}
      />
    </div>
  );
}

// Shown for a region with no downloaded pack: offers its all-taxa pack directly instead of
// sending the user off to Offline packs for what's usually one obvious action. With `banner`, it
// sits compactly above the species that are already yours there (photographed or added by hand).
export function NeedsPackPrompt({
  region,
  onDownloaded,
  banner,
}: {
  region: { id: string; name: string };
  onDownloaded: () => void;
  banner?: boolean;
}) {
  const { t } = useTranslation();
  // undefined while the index loads ("checking"), null when no pack covers the region.
  const { packs, freeBytes, indexUnavailable, error: packsError } = usePackIndex();
  const connection = useConnection();
  const pack = packs
    ? (packs.find((p) => p.type === "region" && p.region === region.name) ?? null)
    : packsError
      ? null
      : undefined;
  const { job, download, running, startedHere } = usePackDownloadAndWait(onDownloaded);

  return (
    <Panel className={banner ? "mb-4 text-center" : "text-center"}>
      <h2 className={banner ? "text-headline font-semibold text-ink" : "text-title-3 font-semibold text-ink"}>
        {t("collection.packPrompt.notDownloaded", { region: region.name })}
      </h2>
      {banner && (
        <p className="mx-auto mt-1 max-w-md text-callout text-muted">{t("collection.packPrompt.bannerHint")}</p>
      )}
      {pack === undefined ? (
        <p className="mt-2 text-callout text-muted">{t("collection.packPrompt.checking")}</p>
      ) : (connection === "offline" && !running) || (indexUnavailable && pack === null) ? (
        // No list yet reads as slow, never as "nothing published".
        <ConnectionNote
          state={connection === "online" ? "slow" : connection}
          className="mx-auto mt-2 max-w-sm justify-center"
        />
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-callout text-muted">
          <Trans
            i18nKey="collection.packPrompt.noPack"
            values={{ region: region.name }}
            components={{
              a: <Link to={SPECIES_DOWNLOADS_PATH} state={{ backLabel: t("nav.collection") }} className="underline" />,
            }}
          />
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-callout text-muted">
            {t("collection.packPrompt.size", { count: pack.speciesCount, size: formatBytes(pack.sizeBytes) })}
            <FreeSpaceNote needed={pack.sizeBytes} free={freeBytes} />
          </p>
          {running ? (
            <DownloadProgress job={job} />
          ) : (
            <>
              <Button onClick={() => void download([pack.id])} disabled={job.starting} className="mt-4">
                {job.starting
                  ? t("collection.packPrompt.starting")
                  : t("collection.packPrompt.downloadRegion", { region: region.name })}
              </Button>
              <DownloadOutcome job={job} startedHere={startedHere} />
            </>
          )}
        </>
      )}
    </Panel>
  );
}

interface SeaZonePack {
  zoneId: string;
  zoneName: string;
  pack: PackStatusEntry;
}

// Shown instead of an empty grid when the region has some pack, just not the filtered taxon's.
// With `photographed`, it renders as a compact banner above the grid instead.
export function TaxonPackPrompt({
  regionId,
  regionName,
  taxon,
  onDownloaded,
  photographed,
}: {
  regionId: string;
  regionName: string;
  taxon: TaxonFilter;
  onDownloaded: () => void;
  photographed?: number;
}) {
  const { t } = useTranslation();
  const otherTaxa = isOtherTaxaFilter(taxon);
  // Fish can also come from a nearby sea zone's own pack. The zones are tagged with the region they
  // were looked up for, so another region reads as "checking" until its own answer arrives.
  const { packs, freeBytes, indexUnavailable, error: packsError } = usePackIndex();
  const connection = useConnection();
  const wantsZones = taxon === "actinopterygii" && !otherTaxa;
  const [zonesFor, setZonesFor] = useState<{ regionId: string; zones: Array<{ id: string; name: string }> } | null>(
    null,
  );
  const zones = wantsZones ? (zonesFor?.regionId === regionId ? zonesFor.zones : null) : NO_ZONES;
  // Zone packs downloaded from here drop out at once, before the index refresh lands.
  const [downloadedZonePackIds, setDownloadedZonePackIds] = useState<string[]>([]);
  const [downloadingZoneId, setDownloadingZoneId] = useState<string | null>(null);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const { job, download, running, startedHere } = usePackDownloadAndWait((ids) => {
    setDownloadedZonePackIds((prev) => [...prev, ...ids]);
    setDownloadingZoneId(null);
    onDownloaded();
  });

  useEffect(() => {
    // Other Taxa species are added one at a time, never from a pack (and that view returns early).
    if (!wantsZones) return;
    let cancelled = false;
    api
      .get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
      .then((res) => {
        if (!cancelled) setZonesFor({ regionId, zones: res.zones });
      })
      .catch(() => {
        if (!cancelled) setZonesFor({ regionId, zones: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [regionId, wantsZones]);

  const lookup = useMemo(() => {
    if (packsError && !packs) return { pack: null, seaZonePacks: [] as SeaZonePack[] };
    if (!packs || zones === null) return null;
    const candidates = packs.filter((p) => p.type === "region" && p.region === regionName);
    return {
      pack: candidates.find((p) => p.taxon === taxon) ?? candidates.find((p) => !p.taxon) ?? null,
      seaZonePacks: zones
        .map((zone) => ({
          zoneId: zone.id,
          zoneName: zone.name,
          pack: packs.find((p) => p.type === "seaZone" && p.seaZone === zone.name),
        }))
        .filter((z): z is SeaZonePack => !!z.pack && !z.pack.downloaded && !downloadedZonePackIds.includes(z.pack.id)),
    };
  }, [packs, packsError, zones, regionName, taxon, downloadedZonePackIds]);
  const pack = lookup ? lookup.pack : undefined;
  const seaZonePacks = lookup ? lookup.seaZonePacks : null;

  if (otherTaxa) {
    return (
      <Panel className="text-center">
        <h2 className="text-title-3 font-semibold text-ink">
          {taxon === "other-taxa"
            ? t("collection.packPrompt.otherTaxaTitle", { region: regionName })
            : t("collection.packPrompt.otherTaxaGroupTitle", {
                group: taxonFilterLabel(taxon, []).toLowerCase(),
                region: regionName,
              })}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-callout text-muted">{t("collection.packPrompt.otherTaxaBody")}</p>
        <Button onClick={() => setOtherTaxaModalOpen(true)} className="mt-4">
          {t("collection.packPrompt.searchInaturalist")}
        </Button>
        {otherTaxaModalOpen && (
          <AddOtherTaxaModal initialQuery="" initialRegionId={regionId} onClose={() => setOtherTaxaModalOpen(false)} />
        )}
      </Panel>
    );
  }

  const taxonName = taxonFilterLabel(taxon, []).toLowerCase();
  const zoneRunning = running && downloadingZoneId !== null;
  const banner = photographed != null && photographed > 0;

  return (
    <Panel className={banner ? "mb-4 text-center" : "text-center"}>
      <h2 className={banner ? "text-headline font-semibold text-ink" : "text-title-3 font-semibold text-ink"}>
        {banner
          ? t("collection.packPrompt.taxonBanner", { count: photographed, taxon: taxonName, region: regionName })
          : t("collection.packPrompt.taxonNotDownloaded", { taxon: taxonName, region: regionName })}
      </h2>
      {pack === undefined ? (
        <p className="mt-2 text-callout text-muted">{t("collection.packPrompt.checking")}</p>
      ) : (connection === "offline" && !running) || (indexUnavailable && pack === null) ? (
        // No list yet reads as slow, never as "nothing published".
        <ConnectionNote
          state={connection === "online" ? "slow" : connection}
          className="mx-auto mt-2 max-w-sm justify-center"
        />
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-callout text-muted">
          <Trans
            i18nKey="collection.packPrompt.noTaxonPack"
            values={{ region: regionName, taxon: taxonName }}
            components={{
              a: <Link to={SPECIES_DOWNLOADS_PATH} state={{ backLabel: t("nav.collection") }} className="underline" />,
            }}
          />
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-callout text-muted">
            {banner
              ? t("collection.packPrompt.taxonBannerSize", {
                  region: regionName,
                  taxon: taxonName,
                  count: pack.speciesCount,
                  size: formatBytes(pack.sizeBytes),
                })
              : t("collection.packPrompt.size", { count: pack.speciesCount, size: formatBytes(pack.sizeBytes) })}
            <FreeSpaceNote needed={pack.sizeBytes} free={freeBytes} />
          </p>
          {running && !zoneRunning ? (
            <DownloadProgress job={job} />
          ) : (
            <>
              <Button
                onClick={() => {
                  setDownloadingZoneId(null);
                  void download([pack.id]);
                }}
                disabled={job.starting || running}
                className="mt-4"
              >
                {job.starting && downloadingZoneId === null
                  ? t("collection.packPrompt.starting")
                  : t("collection.packPrompt.downloadNow")}
              </Button>
              {downloadingZoneId === null && <DownloadOutcome job={job} startedHere={startedHere} />}
            </>
          )}
        </>
      )}
      {seaZonePacks !== null && seaZonePacks.length > 0 && (
        <div className="mx-auto mt-6 max-w-sm border-t border-line pt-4 text-left">
          <p className="text-callout text-muted">{t("collection.packPrompt.seaZones", { region: regionName })}</p>
          <div className="mt-3 space-y-2">
            {seaZonePacks.map((zone) => (
              <div key={zone.zoneId} className="space-y-2 rounded-panel border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-callout text-ink">
                    {zone.zoneName}{" "}
                    <span className="text-muted">
                      {t("collection.packPrompt.zoneCount", { count: zone.pack.speciesCount })}
                    </span>
                  </span>
                  {!(zoneRunning && downloadingZoneId === zone.zoneId) && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDownloadingZoneId(zone.zoneId);
                        void download([zone.pack.id]);
                      }}
                      disabled={job.starting || running || connection === "offline"}
                      className="shrink-0"
                    >
                      {t("collection.packPrompt.download")}
                    </Button>
                  )}
                </div>
                {downloadingZoneId === zone.zoneId &&
                  (running ? (
                    <PackProgress
                      status={job.status}
                      onCancel={(downloadsOnly) =>
                        void job.cancel(CANCEL_URL, downloadsOnly ? { downloadsOnly } : undefined)
                      }
                      cancelling={job.cancelling}
                    />
                  ) : (
                    <JobProgress
                      status={startedHere ? job.status : null}
                      error={job.actionError}
                      errorPrefix={t("collection.packPrompt.zoneFailed")}
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
