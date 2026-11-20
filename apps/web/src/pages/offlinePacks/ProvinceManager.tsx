import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, ApiError, type ApiResponse } from "../../api/client";
import FormMessage from "../../components/FormMessage";
import i18n from "../../i18n";
import type { usePackDownloadJob } from "../../hooks/usePackDownloadStatus";
import { useLatest } from "../../hooks/useLatest";
import { nextPackDownloadFinish } from "../../lib/waitForPackDownload";
import Checkbox from "../../components/Checkbox";

type ProvincesResponse = ApiResponse<"/offline-packs/{packId}/provinces">;
type ProvinceEntry = ProvincesResponse["provinces"][number];

// A downloaded country pack's provinces, each one offloadable and re-addable on its own.
export default function ProvinceManager({
  packId,
  subdivisionLabel,
  onSubdivisionLabel,
  downloadJob,
  onPacksChanged,
}: {
  packId: string;
  subdivisionLabel: string;
  onSubdivisionLabel: (label: string) => void;
  downloadJob: ReturnType<typeof usePackDownloadJob>;
  onPacksChanged: () => void;
}) {
  const { t } = useTranslation();
  const [provinceList, setProvinceList] = useState<ProvinceEntry[] | null>(null);
  const [provinceError, setProvinceError] = useState<string | null>(null);
  const [provinceBusyId, setProvinceBusyId] = useState<string | null>(null);
  const onLabelRef = useLatest(onSubdivisionLabel);

  useEffect(() => {
    let cancelled = false;
    api
      .get(apiPath("/offline-packs/{packId}/provinces", { packId }))
      .then((res) => {
        if (cancelled) return;
        setProvinceList(res.provinces);
        onLabelRef.current(res.subdivisionLabel);
      })
      .catch((err) => {
        if (!cancelled)
          setProvinceError(err instanceof ApiError ? err.message : i18n.t("offlinePacks.provinceManager.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [packId, onLabelRef]);

  async function offloadProvince(province: ProvinceEntry) {
    setProvinceBusyId(province.id);
    setProvinceError(null);
    try {
      await api.post(apiPath("/offline-packs/{packId}/provinces/offload", { packId }), { regionIds: [province.id] });
      setProvinceList((prev) => prev?.map((p) => (p.id === province.id ? { ...p, applied: false } : p)) ?? null);
    } catch (err) {
      setProvinceError(err instanceof ApiError ? err.message : t("offlinePacks.provinceManager.offloadFailed"));
    } finally {
      setProvinceBusyId(null);
    }
  }

  // There's no "apply one province" path: the whole pack is re-downloaded (restoring every
  // province), then the ones still meant to be excluded are trimmed back out.
  async function reapplyProvince(province: ProvinceEntry) {
    if (!provinceList) return;
    setProvinceBusyId(province.id);
    setProvinceError(null);
    try {
      const wait = nextPackDownloadFinish([packId]);
      if (!(await downloadJob.start("/offline-packs/download", { packIds: [packId], force: true }))) {
        wait.cancel();
        throw new Error(t("offlinePacks.downloaded.downloadStartFailed"));
      }
      const jobStatus = await wait.finished;
      if (jobStatus.error) throw new Error(jobStatus.error);
      if (jobStatus.cancelled) throw new Error(t("offlinePacks.downloaded.downloadCancelled"));
      const stillExcluded = provinceList.filter((p) => !p.applied && p.id !== province.id).map((p) => p.id);
      if (stillExcluded.length > 0) {
        await api.post(apiPath("/offline-packs/{packId}/provinces/offload", { packId }), { regionIds: stillExcluded });
      }
      const res = await api.get(apiPath("/offline-packs/{packId}/provinces", { packId }));
      setProvinceList(res.provinces);
      onPacksChanged();
    } catch (err) {
      setProvinceError(
        err instanceof Error && err.message ? err.message : t("offlinePacks.provinceManager.reapplyFailed"),
      );
    } finally {
      setProvinceBusyId(null);
    }
  }

  return (
    <div className="mt-2 ml-6">
      <FormMessage error={provinceError} className="text-footnote" />
      {!provinceList && !provinceError && (
        <p className="text-footnote text-muted">
          {t("offlinePacks.provinceManager.loading", { subdivisions: subdivisionLabel.toLowerCase() })}
        </p>
      )}
      {provinceList && provinceList.length === 0 && (
        <p className="text-footnote text-muted">
          {t("offlinePacks.provinceManager.none", { subdivisions: subdivisionLabel.toLowerCase() })}
        </p>
      )}
      {provinceList && provinceList.length > 0 && (
        <ul className="max-h-64 divide-y divide-line overflow-y-auto border-l border-line pl-2">
          {provinceList.map((province) => (
            <li key={province.id} className="flex items-center gap-2 py-1 text-footnote">
              <Checkbox
                size="sm"
                checked={province.applied}
                disabled={provinceBusyId === province.id}
                onChange={() => (province.applied ? offloadProvince(province) : reapplyProvince(province))}
              >
                {province.name}
              </Checkbox>
              {provinceBusyId === province.id && (
                <span className="text-muted">{t("offlinePacks.provinceManager.working")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
