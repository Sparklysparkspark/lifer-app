import { useEffect, useRef, useState } from "react";
import { useLatest } from "../../hooks/useLatest";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import { formatBytes } from "../../lib/format";
import AddOtherTaxaModal from "../../components/AddOtherTaxaModal";
import JobProgress from "../../components/JobProgress";
import { buttonClasses } from "../../lib/buttonClasses";
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
      <JobProgress
        status={startedHere ? job.status : null}
        error={job.actionError}
        errorPrefix="Couldn't download this pack"
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
  // Tagged with the region it was looked up for, so another region reads as "checking" until its
  // own answer arrives.
  const [found, setFound] = useState<{ region: string; pack: OfflinePackEntry | null } | null>(null);
  const pack = found?.region === region.name ? found.pack : undefined;
  const { job, download, running, startedHere } = usePackDownloadAndWait(onDownloaded);

  useEffect(() => {
    let cancelled = false;
    const name = region.name;
    api
      .get<{ packs: OfflinePackEntry[] }>("/offline-packs/index")
      .then((res) => {
        if (!cancelled)
          setFound({ region: name, pack: res.packs.find((p) => p.type === "region" && p.region === name) ?? null });
      })
      .catch(() => {
        if (!cancelled) setFound({ region: name, pack: null });
      });
    return () => {
      cancelled = true;
    };
  }, [region.name]);

  return (
    <div
      className={
        banner
          ? "mb-4 rounded-xl border border-line bg-surface p-5 text-center"
          : "rounded-xl border border-line bg-surface p-8 text-center"
      }
    >
      <h2 className={banner ? "text-base font-semibold text-ink" : "text-lg font-semibold text-ink"}>
        {region.name}'s checklist isn't downloaded yet
      </h2>
      {banner && (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          Below are the species you've photographed here or added yourself. The pack adds the rest.
        </p>
      )}
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
              <button
                onClick={() => void download([pack.id])}
                disabled={job.starting}
                className={buttonClasses("primary", "md", "mt-4")}
              >
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

interface SeaZonePack {
  zoneId: string;
  zoneName: string;
  pack: OfflinePackEntry;
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
  // Tagged with what it was looked up for, so a different region or taxon reads as "checking"
  // until its own answer arrives. Fish can also come from a nearby sea zone's own pack.
  const lookupKey = JSON.stringify([regionId, regionName, taxon]);
  const [found, setFound] = useState<{
    key: string;
    pack: OfflinePackEntry | null;
    seaZonePacks: SeaZonePack[];
  } | null>(null);
  const current = found?.key === lookupKey ? found : null;
  const pack = current ? current.pack : undefined;
  const seaZonePacks = current ? current.seaZonePacks : null;
  const [downloadingZoneId, setDownloadingZoneId] = useState<string | null>(null);
  const [otherTaxaModalOpen, setOtherTaxaModalOpen] = useState(false);
  const { job, download, running, startedHere } = usePackDownloadAndWait((ids) => {
    setFound((prev) => prev && { ...prev, seaZonePacks: prev.seaZonePacks.filter((z) => !ids.includes(z.pack.id)) });
    setDownloadingZoneId(null);
    onDownloaded();
  });

  useEffect(() => {
    // Other Taxa species are added one at a time, never from a pack (and that view returns early).
    if (otherTaxa) return;
    let cancelled = false;
    const key = JSON.stringify([regionId, regionName, taxon]);
    Promise.all([
      api.get<{ packs: OfflinePackEntry[] }>("/offline-packs/index"),
      taxon === "actinopterygii"
        ? api.get<{ zones: Array<{ id: string; name: string }> }>(`/regions/${regionId}/sea-zones`)
        : Promise.resolve({ zones: [] }),
    ])
      .then(([{ packs }, { zones }]) => {
        if (cancelled) return;
        const candidates = packs.filter((p) => p.type === "region" && p.region === regionName);
        setFound({
          key,
          pack: candidates.find((p) => p.taxon === taxon) ?? candidates.find((p) => !p.taxon) ?? null,
          seaZonePacks: zones
            .map((zone) => ({
              zoneId: zone.id,
              zoneName: zone.name,
              pack: packs.find((p) => p.type === "seaZone" && p.seaZone === zone.name),
            }))
            .filter((z): z is SeaZonePack => !!z.pack && !z.pack.downloaded),
        });
      })
      .catch(() => {
        if (!cancelled) setFound({ key, pack: null, seaZonePacks: [] });
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
          There's no pack to download for this one, Other Taxa covers whatever Lifer doesn't already have a dataset for
          (insects, plants, fungi, and more). Jump to a species by scientific name (that matches best) and you'll get
          the option to search iNaturalist and add it here, or paste in a whole list of names at once from the same
          search screen.
        </p>
        <button onClick={() => setOtherTaxaModalOpen(true)} className={buttonClasses("primary", "md", "mt-4")}>
          Search iNaturalist
        </button>
        {otherTaxaModalOpen && (
          <AddOtherTaxaModal initialQuery="" initialRegionId={regionId} onClose={() => setOtherTaxaModalOpen(false)} />
        )}
      </div>
    );
  }

  const taxonName = taxonFilterLabel(taxon, []).toLowerCase();
  const zoneRunning = running && downloadingZoneId !== null;
  const banner = photographed != null && photographed > 0;

  return (
    <div
      className={
        banner
          ? "mb-4 rounded-xl border border-line bg-surface p-5 text-center"
          : "rounded-xl border border-line bg-surface p-8 text-center"
      }
    >
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
            Or get fish from a nearby sea zone instead. It's a separate, optional download, not part of {regionName}'s
            own pack above:
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
                    <JobProgress
                      status={startedHere ? job.status : null}
                      error={job.actionError}
                      errorPrefix="Couldn't download this pack"
                    />
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
