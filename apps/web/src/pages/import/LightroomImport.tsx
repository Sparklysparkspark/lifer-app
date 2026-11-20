import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { JobStatus } from "@lifer/shared";
import { api } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import JobProgress from "../../components/JobProgress";
import PageHeader from "../../components/PageHeader";
import Switch from "../../components/Switch";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { useJobPoll } from "../../hooks/useJobPoll";
import { errorMessage } from "../../lib/errorMessage";
import { formatNumber } from "../../lib/format";
import { SettingRow, SettingsGroup } from "../settings/shared";

type Group = "ratings" | "flags" | "keywords" | "locations" | "albums" | "smartAlbums";

interface GroupPreview {
  group: Group;
  total: number;
  willChange: number;
  conflicts: number;
  samples: string[];
}

interface Preview {
  total: number;
  matched: number;
  notInLifer: number;
  groups: GroupPreview[];
  unmapped: { kind: string; name: string; reason: string }[];
  leftOut: { labels: number; captions: number };
}

type ReadStatus = JobStatus<{ path: string; preview: Preview }>;
type ApplyStatus = JobStatus<{ photos: number; albums: number }>;

// The most unmapped collections listed; the rest are counted.
const UNMAPPED_SHOWN = 8;

/** Reads a Lightroom Classic catalogue, shows what it would change, and applies the kinds the user
 *  keeps switched on. Desktop only: the catalogue is a file on this computer. */
export default function LightroomImport() {
  const { t } = useTranslation();
  const mode = useDeploymentMode();
  const [path, setPath] = useState<string | null>(null);
  const [off, setOff] = useState<ReadonlySet<Group>>(new Set());
  const [lightroomWins, setLightroomWins] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undone, setUndone] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // What "Undo import" would undo; kept on disk, so it is still there after a restart.
  const [last, setLast] = useState<{ photos: number; albums: number } | null>(null);
  const loadLast = useCallback(
    () =>
      api
        .get("/lightroom/undo")
        .then((r) => setLast(r.last))
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    if (mode === "desktop") void loadLast();
  }, [mode, loadLast]);
  const read = useJobPoll<ReadStatus>("/lightroom/preview", { intervalMs: 1000, enabled: path !== null });
  const apply = useJobPoll<ApplyStatus>("/lightroom/apply", {
    intervalMs: 1000,
    enabled: path !== null,
    onFinish: () => void loadLast(),
  });
  const preview = read.status?.result?.path === path ? read.status.result.preview : null;
  const applied = apply.status?.result ?? null;

  const groupLabel: Record<Group, string> = {
    ratings: t("lightroom.group.ratings"),
    flags: t("lightroom.group.flags"),
    keywords: t("lightroom.group.keywords"),
    locations: t("lightroom.group.locations"),
    albums: t("lightroom.group.albums"),
    smartAlbums: t("lightroom.group.smartAlbums"),
  };
  const phases = {
    reading: { label: t("lightroom.reading"), progress: "none" as const },
    applying: { label: t("lightroom.applying"), progress: "count" as const },
  };

  async function choose() {
    setError(null);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({ filters: [{ name: t("lightroom.fileKind"), extensions: ["lrcat"] }] });
      if (typeof chosen !== "string") return;
      setPath(chosen);
      setOff(new Set());
      setUndone(false);
      await read.start("/lightroom/preview", { path: chosen });
    } catch (err) {
      setError(errorMessage(err, t("lightroom.chooseFailed")));
    }
  }

  async function startApply() {
    if (!path || !preview) return;
    setUndone(false);
    await apply.start("/lightroom/apply", {
      path,
      groups: preview.groups.filter((g) => !off.has(g.group)).map((g) => g.group),
      lightroomWins,
    });
  }

  async function undo() {
    setUndoing(true);
    try {
      await api.post("/lightroom/undo");
      setUndone(true);
      setLast(null);
    } catch (err) {
      setError(errorMessage(err, t("lightroom.undoFailed")));
    } finally {
      setUndoing(false);
    }
  }

  const toggle = (group: Group, on: boolean) =>
    setOff((prev) => {
      const next = new Set(prev);
      if (on) next.delete(group);
      else next.add(group);
      return next;
    });
  const hasConflicts = preview?.groups.some((g) => g.conflicts > 0) ?? false;
  const anyOn = preview?.groups.some((g) => !off.has(g.group) && g.total > 0) ?? false;
  const running = apply.status?.running ?? false;

  if (mode === "server")
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-page">
        <PageHeader title={t("lightroom.title")} backFallbackTo="/import" />
        <p className="text-subheadline text-muted">{t("lightroom.desktopOnly")}</p>
      </div>
    );

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-page">
      <PageHeader title={t("lightroom.title")} backFallbackTo="/import">
        <p className="text-subheadline text-muted">{t("lightroom.intro")}</p>
      </PageHeader>

      <SettingsGroup title={t("lightroom.catalogue")}>
        <SettingRow
          label={path ? (path.split(/[\\/]/).pop() ?? path) : t("lightroom.noneChosen")}
          description={path ?? t("lightroom.readOnly")}
          control={
            <Button variant="secondary" onClick={() => void choose()} disabled={read.status?.running || running}>
              {path ? t("lightroom.change") : t("lightroom.choose")}
            </Button>
          }
        />
      </SettingsGroup>
      <JobProgress status={read.status} phases={phases} error={read.actionError} />
      <FormMessage error={error ?? apply.actionError ?? read.status?.error ?? null} />

      {preview && (
        <>
          <p className="text-subheadline text-muted">
            {t("lightroom.found", { total: formatNumber(preview.total), matched: formatNumber(preview.matched) })}
          </p>
          <SettingsGroup title={t("lightroom.changes")}>
            {preview.groups.map((g) => (
              <SettingRow
                key={g.group}
                label={groupLabel[g.group]}
                description={
                  g.total === 0
                    ? t("lightroom.nothing")
                    : t("lightroom.groupCounts", {
                        total: formatNumber(g.total),
                        change: formatNumber(g.willChange),
                        conflicts: g.conflicts,
                      })
                }
                control={
                  <Switch
                    label={groupLabel[g.group]}
                    checked={g.total > 0 && !off.has(g.group)}
                    disabled={g.total === 0 || running}
                    onChange={(on) => toggle(g.group, on)}
                  />
                }
              >
                {g.samples.length > 0 && <p className="truncate text-footnote text-muted">{g.samples.join(" · ")}</p>}
              </SettingRow>
            ))}
            {hasConflicts && (
              <SettingRow
                label={t("lightroom.wins")}
                description={t("lightroom.winsDescription")}
                control={
                  <Switch
                    label={t("lightroom.wins")}
                    checked={lightroomWins}
                    disabled={running}
                    onChange={setLightroomWins}
                  />
                }
              />
            )}
          </SettingsGroup>

          {(preview.leftOut.labels > 0 || preview.leftOut.captions > 0) && (
            <p className="text-footnote text-muted">
              {t("lightroom.leftOut", { labels: preview.leftOut.labels, captions: preview.leftOut.captions })}
            </p>
          )}
          {preview.unmapped.length > 0 && (
            <SettingsGroup title={t("lightroom.unmapped", { count: preview.unmapped.length })}>
              {preview.unmapped.slice(0, UNMAPPED_SHOWN).map((u, i) => (
                <SettingRow key={i} label={<span className="break-words">{u.name}</span>} description={u.reason} />
              ))}
              {preview.unmapped.length > UNMAPPED_SHOWN && (
                <SettingRow label={t("lightroom.unmappedMore", { count: preview.unmapped.length - UNMAPPED_SHOWN })} />
              )}
            </SettingsGroup>
          )}
          {preview.notInLifer > 0 && (
            <p className="text-footnote text-muted">
              {t("lightroom.notInLifer", { count: preview.notInLifer })}{" "}
              <Link to="/settings/library" className="text-accent underline">
                {t("lightroom.addFolders")}
              </Link>
            </p>
          )}

          <JobProgress status={apply.status} phases={phases} />
          {applied && !running && !undone && (
            <FormMessage
              success={t("lightroom.done", { photos: formatNumber(applied.photos), albums: applied.albums })}
            />
          )}
          {undone && <FormMessage success={t("lightroom.undone")} />}
          <div className="flex items-center gap-2">
            <Button onClick={() => void startApply()} disabled={!anyOn || running} loading={apply.starting}>
              {t("lightroom.apply")}
            </Button>
            {last && !running && (
              <Button variant="secondary" onClick={() => void undo()} loading={undoing}>
                {t("lightroom.undo", { photos: formatNumber(last.photos), albums: last.albums })}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
