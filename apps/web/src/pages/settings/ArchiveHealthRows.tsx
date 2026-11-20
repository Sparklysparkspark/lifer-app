import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { errorMessage } from "../../lib/errorMessage";
import { formatRelativeTime } from "../../lib/format";
import { ignore } from "../../lib/ignore";
import { SettingLinkRow, SettingSwitchRow } from "./shared";

type Summary = Awaited<ReturnType<typeof loadSummary>>;

const loadSummary = () => api.get("/originals/health");

// Settings > Storage: the archive health switch, its status line, and a link to the problem files.
export default function ArchiveHealthRows() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () =>
      loadSummary()
        .then((s) => {
          if (!live) return;
          setSummary(s);
          // Progress moves slowly (the check is throttled), so a few seconds is plenty.
          if (s.running) timer = setTimeout(poll, 3000);
        })
        .catch(ignore("Couldn't load archive health"));
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [saving]);

  if (!summary) return null;

  async function save(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      await api.put("/originals/health", { enabled });
    } catch (err) {
      setError(errorMessage(err, t("settings.storage.health.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  const offline = summary.notChecked.map((d) =>
    t("settings.storage.health.notConnected", { count: d.count, drive: d.label }),
  );
  const status = !summary.enabled
    ? t("settings.storage.health.description")
    : summary.running && summary.total
      ? t("settings.storage.health.checking", { processed: summary.processed ?? 0, total: summary.total })
      : !summary.lastCheckedAt
        ? t("settings.storage.health.firstCheck")
        : [
            summary.problemCount > 0
              ? t("settings.storage.health.lastChecked", { when: formatRelativeTime(summary.lastCheckedAt) })
              : t("settings.storage.health.allOk", {
                  when: formatRelativeTime(summary.lastCheckedAt),
                  count: summary.checkedCount,
                }),
            ...offline,
          ].join(" · ");

  return (
    <>
      <SettingSwitchRow
        label={t("settings.storage.health.label")}
        description={status}
        setting={{ value: summary.enabled, saving, error, save }}
      />
      {summary.enabled && summary.problemCount > 0 && (
        <SettingLinkRow
          label={t("settings.storage.health.problems", { count: summary.problemCount })}
          description={t("settings.storage.health.problemsDescription")}
          to="/archive-health"
        />
      )}
    </>
  );
}
