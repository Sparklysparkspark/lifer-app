import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { formatBytes } from "../../lib/formatBytes";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import JobProgress from "../../components/JobProgress";
import { buttonClasses } from "../../components/Button";
import { PACK_DOWNLOAD_PHASES, packProgressDetail, usePackDownloadJob } from "../../hooks/usePackDownloadStatus";
import { isOtherTaxaFilter, taxonFilterLabel, type TaxonFilter } from "./taxonLabels";

interface OfflinePackEntry {
  id: string;
  type: "region" | "seaZone";
  region?: string;
  seaZone?: string;
  taxon?: string | null;
  sizeBytes: number;
  speciesCount: number;
  downloaded: boolean;
}

const CANCEL_URL = "/offline-packs/download/cancel";

// Starts a pack download and follows the shared job. onDone fires when a download started from
// here finishes cleanly; the error or cancelled state stays on screen otherwise.
function usePackDownloadAndWait(onDone: (packIds: string[]) => void) {
  const startedIds = useRef<string[] | null>(null);
  const [startedHere, setStartedHere] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
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
      <JobProgress
        status={job.status}
        phases={PACK_DOWNLOAD_PHASES}
        fallbackLabel="Downloading…"
        detail={packProgressDetail(job.status)}
        onCancel={() => void job.cancel(CANCEL_URL)}
        cancelling={job.cancelling}
      />
    </div>
  );
}

function DownloadOutcome({ job, startedHere }: { job: ReturnType<typeof usePackDownloadJob>; startedHere: boolean }) {
  return (
    <div className="mx-auto mt-2 max-w-sm text-left">
      <JobProgress status={startedHere ? job.status : null} error={job.actionError} errorPrefix="Couldn't download this pack" />
    </div>
  );
}

// Shown for a region with no downloaded pack: offers its all-taxa pack directly instead of
// sending the user off to Offline packs for what's usually one obvious action.
export function NeedsPackPrompt({ region, onDownloaded }: { region: { id: string; name: string }; onDownloaded: () => void }) {
  const [pack, setPack] = useState<OfflinePackEntry | null | undefined>(undefined);
  const { job, download, running, startedHere } = usePackDownloadAndWait(onDownloaded);

  useEffect(() => {
    let cancelled = false;
    setPack(undefined);
    api
      .get<{ packs: OfflinePackEntry[] }>("/offline-packs/index")
      .then((res) => {
        if (!cancelled) setPack(res.packs.find((p) => p.type === "region" && p.region === region.name) ?? null);
      })
      .catch(() => {
        if (!cancelled) setPack(null);
      });
    return () => {
      cancelled = true;
    };
  }, [region.name]);

  return (
    <div className="rounded-xl border border-line bg-surface p-8 text-center">
      <h2 className="text-lg font-semibold text-ink">{region.name}'s checklist isn't downloaded yet</h2>
      {pack === undefined ? (
        <p className="mt-2 text-sm text-muted">Checking for a pack…</p>
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          No offline pack is published for {region.name} yet. Check{" "}
          <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
            Offline packs
          </Link>{" "}
          later, or ask whoever runs this Lifer instance about it.
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {pack.speciesCount} species, {formatBytes(pack.sizeBytes)}.
          </p>
          {running ? (
            <DownloadProgress job={job} />
          ) : (
            <>
              <button onClick={() => void download([pack.id])} disabled={job.starting} className={buttonClasses("primary", "md", "mt-4")}>
                {job.starting ? "Starting…" : `Download ${region.name}'s pack`}
              </button>
              <DownloadOutcome job={job} startedHere={startedHere} />
            </>
          )}
        </>
      )}
    </div>
  );
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
  const otherTaxa = isOtherTaxaFilter(taxon);
  const [pack, setPack] = useState<OfflinePackEntry | null | undefined>(undefined);
  // Fish can also come from a nearby sea zone's own pack, for someone after ocean fish.
  const [seaZonePacks, setSeaZonePacks] = useState<Array<{ zoneId: string; zoneName: string; pack: OfflinePackEntry }> | null>(null);
  const [downloadingZoneId, setDownloadingZoneId] = useState<string | null>(null);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const { job, download, running, startedHere } = usePackDownloadAndWait((ids) => {
    setSeaZonePacks((prev) => prev?.filter((z) => !ids.includes(z.pack.id)) ?? null);
    setDownloadingZoneId(null);
    onDownloaded();
  });

  useEffect(() => {
    // Other Taxa species are added one at a time, never from a pack.
    if (otherTaxa) {
      setPack(null);
      setSeaZonePacks([]);
      return;
    }
    let cancelled = false;
    setPack(undefined);
    setSeaZonePacks(null);
    Promise.all([
      api.get<{ packs: OfflinePackEntry[] }>("/offline-packs/index"),
      taxon === "actinopterygii"
        ? api.get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
        : Promise.resolve({ zones: [] }),
    ])
      .then(([{ packs }, { zones }]) => {
        if (cancelled) return;
        const candidates = packs.filter((p) => p.type === "region" && p.region === regionName);
        setPack(candidates.find((p) => p.taxon === taxon) ?? candidates.find((p) => !p.taxon) ?? null);
        setSeaZonePacks(
          zones
            .map((zone) => ({ zoneId: zone.id, zoneName: zone.name, pack: packs.find((p) => p.type === "seaZone" && p.seaZone === zone.name) }))
            .filter((z): z is { zoneId: string; zoneName: string; pack: OfflinePackEntry } => !!z.pack && !z.pack.downloaded),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setPack(null);
        setSeaZonePacks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [regionId, regionName, taxon, otherTaxa]);

  if (otherTaxa) {
    return (
      <div className="rounded-xl border border-line bg-surface p-8 text-center">
        <h2 className="text-lg font-semibold text-ink">No Other Taxa added for {regionName} yet</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          There's no pack to download for this one, Other Taxa covers whatever Lifer doesn't already have a dataset for (insects,
          plants, fungi, and more). Jump to a species by scientific name (that matches best) and you'll get the option to search
          iNaturalist and add it here, or paste in a whole list of names at once from the same search screen.
        </p>
        <button onClick={() => setOtherTaxaModalOpen(true)} className={buttonClasses("primary", "md", "mt-4")}>
          Search iNaturalist
        </button>
        {otherTaxaModalOpen && <AddOtherTaxaModal initialQuery="" initialRegionId={regionId} onClose={() => setOtherTaxaModalOpen(false)} />}
      </div>
    );
  }

  const taxonName = taxonFilterLabel(taxon, []).toLowerCase();
  const zoneRunning = running && downloadingZoneId !== null;
  const banner = photographed != null && photographed > 0;

  return (
    <div className={banner ? "mb-4 rounded-xl border border-line bg-surface p-5 text-center" : "rounded-xl border border-line bg-surface p-8 text-center"}>
      <h2 className={banner ? "text-base font-semibold text-ink" : "text-lg font-semibold text-ink"}>
        {banner
          ? `You've photographed ${photographed} ${taxonName} species in ${regionName}`
          : `${regionName}'s ${taxonName} pack isn't downloaded yet`}
      </h2>
      {pack === undefined ? (
        <p className="mt-2 text-sm text-muted">Checking for a pack…</p>
      ) : pack === null ? (
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
          No offline pack covers {regionName}'s {taxonName} yet. Check{" "}
          <Link to="/offline-packs" state={{ backLabel: "Collection" }} className="underline">
            Offline packs
          </Link>{" "}
          later.
        </p>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted">
            {banner
              ? `Download ${regionName}'s ${taxonName} pack to see the rest: ${pack.speciesCount} species, ${formatBytes(pack.sizeBytes)}.`
              : `${pack.speciesCount} species, ${formatBytes(pack.sizeBytes)}.`}
          </p>
          {running && !zoneRunning ? (
            <DownloadProgress job={job} />
          ) : (
            <>
              <button
                onClick={() => {
                  setDownloadingZoneId(null);
                  void download([pack.id]);
                }}
                disabled={job.starting || running}
                className={buttonClasses("primary", "md", "mt-4")}
              >
                {job.starting && downloadingZoneId === null ? "Starting…" : "Download now"}
              </button>
              {downloadingZoneId === null && <DownloadOutcome job={job} startedHere={startedHere} />}
            </>
          )}
        </>
      )}
      {seaZonePacks !== null && seaZonePacks.length > 0 && (
        <div className="mx-auto mt-6 max-w-sm border-t border-line pt-4 text-left">
          <p className="text-sm text-muted">
            Or get fish from a nearby sea zone instead. It's a separate, optional download, not part of {regionName}'s own pack above:
          </p>
          <div className="mt-3 space-y-2">
            {seaZonePacks.map((zone) => (
              <div key={zone.zoneId} className="space-y-2 rounded-md border border-line px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-ink">
                    {zone.zoneName} <span className="text-muted">({zone.pack.speciesCount} species)</span>
                  </span>
                  {!(zoneRunning && downloadingZoneId === zone.zoneId) && (
                    <button
                      onClick={() => {
                        setDownloadingZoneId(zone.zoneId);
                        void download([zone.pack.id]);
                      }}
                      disabled={job.starting || running}
                      className={buttonClasses("secondary", "sm", "shrink-0 py-1 text-xs")}
                    >
                      Download
                    </button>
                  )}
                </div>
                {downloadingZoneId === zone.zoneId &&
                  (running ? (
                    <JobProgress
                      status={job.status}
                      phases={PACK_DOWNLOAD_PHASES}
                      fallbackLabel="Downloading…"
                      onCancel={() => void job.cancel(CANCEL_URL)}
                      cancelling={job.cancelling}
                    />
                  ) : (
                    <JobProgress status={startedHere ? job.status : null} error={job.actionError} errorPrefix="Couldn't download this pack" />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
