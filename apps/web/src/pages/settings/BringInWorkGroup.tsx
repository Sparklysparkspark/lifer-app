import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { PluginSummary } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import SearchInput from "../../components/SearchInput";
import { useToast } from "../../hooks/useToast";
import { errorMessage } from "../../lib/errorMessage";
import { formatDate } from "../../lib/format";
import { exportOfferedImport, offeredImports, startPlugin, usePlugins, type OfferedImport } from "../../lib/plugins";
import { SettingRow, SettingsGroup } from "./shared";

// Lists longer than this get a filter box.
const FILTER_AT = 8;

// Past work a connected app offers. Choosing one has the app write it to a folder, then Lifer
// imports that folder in the background, so the dialog and this page stay usable meanwhile.
function AppWork({ app }: { app: PluginSummary }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [work, setWork] = useState<OfferedImport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // Brought in during this visit; the app's list can't say what Lifer already has.
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");

  async function look() {
    setError(null);
    setLooking(true);
    try {
      await startPlugin(app.id);
      setWork(await offeredImports(app.id));
    } catch (err) {
      setError(errorMessage(err, t("settings.library.bringIn.lookFailed", { app: app.name })));
    } finally {
      setLooking(false);
    }
  }

  async function bringIn(item: OfferedImport) {
    setBusy((s) => new Set(s).add(item.id));
    toast.info(t("settings.library.bringIn.started", { work: item.name }));
    try {
      const folder = await exportOfferedImport(app.id, item.id);
      await api.post("/imports/v1/folders", { path: folder, mode: "in-place" });
      toast.success(t("settings.library.bringIn.importing", { work: item.name }));
      setDone((s) => new Set(s).add(item.id));
    } catch (err) {
      toast.error(errorMessage(err, t("settings.library.bringIn.failed", { work: item.name })));
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  }

  const q = query.trim().toLowerCase();
  const shown = (work ?? []).filter((w) => !q || w.name.toLowerCase().includes(q));
  return (
    <SettingsGroup title={t("settings.library.bringIn.title", { app: app.name })}>
      <SettingRow
        label={t("settings.library.bringIn.label")}
        description={t("settings.library.bringIn.description", { app: app.name })}
        control={
          <Button size="sm" variant="secondary" disabled={looking} onClick={() => void look()}>
            {looking ? t("settings.library.bringIn.looking") : t("settings.library.bringIn.look")}
          </Button>
        }
      >
        <FormMessage error={error} />
      </SettingRow>
      {work?.length === 0 && <SettingRow label={t("settings.library.bringIn.none", { app: app.name })} />}
      {!!work?.length && (
        <SettingRow label={t("settings.library.bringIn.label")}>
          {work.length > FILTER_AT && (
            <SearchInput
              value={query}
              onChange={setQuery}
              aria-label={t("settings.library.bringIn.filter")}
              placeholder={t("settings.library.bringIn.filter")}
            />
          )}
          <ul
            aria-label={t("settings.library.bringIn.label")}
            className="max-h-72 divide-y divide-line overflow-y-auto"
          >
            {shown.map((item) => (
              <li key={item.id} className="flex min-h-9 items-center justify-between gap-item py-1">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-callout text-ink" title={item.name}>
                    {item.name}
                  </p>
                  <p className="text-footnote text-muted">
                    {[
                      item.date ? formatDate(item.date) : null,
                      item.fileCount !== null ? t("settings.library.bringIn.files", { count: item.fileCount }) : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                </div>
                {done.has(item.id) ? (
                  <span className="shrink-0 text-footnote text-muted">{t("settings.library.bringIn.done")}</span>
                ) : (
                  <Button size="sm" variant="secondary" disabled={busy.has(item.id)} onClick={() => void bringIn(item)}>
                    {t("settings.library.bringIn.action")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SettingRow>
      )}
    </SettingsGroup>
  );
}

/** Desktop only, and only for apps that offer imports; nothing shows otherwise. */
export default function BringInWorkGroup() {
  const apps = usePlugins()?.filter((p) => p.approved && p.capabilities.includes("offersImports")) ?? [];
  return (
    <>
      {apps.map((app) => (
        <AppWork key={app.id} app={app} />
      ))}
    </>
  );
}
