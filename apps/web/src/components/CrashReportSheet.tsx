import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useToast } from "../hooks/useToast";
import { downloadFile } from "../lib/downloadFile";
import { ignore } from "../lib/ignore";
import Button from "./Button";
import Panel from "./Panel";
import { TextArea } from "./TextField";

type Stored = { id: string; report: { kind: string } & Record<string, unknown> };

const QUIT_KINDS = new Set(["desktop-panic", "server-exception"]);

// The next-launch offer to send what the last crash left behind (api crashReports/). Nothing
// leaves the computer until Send report; either button closes it at once and the rest runs in the
// background. Positioned by StatusTray, so the app stays usable around it.
export default function CrashReportSheet() {
  const { t } = useTranslation();
  const toast = useToast();
  const [reports, setReports] = useState<Stored[]>([]);
  const [note, setNote] = useState("");

  useEffect(() => {
    api
      .get("/crash-reports")
      .then((res) => setReports(res.reports))
      .catch(ignore("Couldn't check for crash reports"));
  }, []);

  if (reports.length === 0) return null;
  const ids = reports.map((r) => r.id);
  const trimmed = note.trim();
  // What each POST carries, as the server will build it (crashReports/report.ts payloadFor).
  const payload = reports
    .map((r) => JSON.stringify(trimmed ? { ...r.report, note: trimmed } : r.report, null, 2))
    .join("\n\n");

  const save = () =>
    downloadFile("/api/crash-reports/download", "lifer-crash-report.json").catch(() =>
      toast.error(t("status.crashReport.saveFailed")),
    );
  const send = () => {
    setReports([]);
    api
      .post("/crash-reports/send", { ids, note: trimmed || undefined })
      .then(() => toast.success(t("status.crashReport.sent")))
      .catch(() =>
        toast.show(t("status.crashReport.notSent"), {
          tone: "error",
          durationMs: null,
          actions: [{ label: t("status.crashReport.save"), onClick: () => void save() }],
        }),
      );
  };
  const dismiss = () => {
    setReports([]);
    api.post("/crash-reports/dismiss", { ids }).catch(ignore("Couldn't delete crash reports"));
  };

  return (
    <Panel as="section" aria-labelledby="crash-report-title" className="w-96 max-w-full space-y-3 shadow-sm">
      <div className="space-y-1">
        <h2 id="crash-report-title" className="text-callout font-semibold text-ink">
          {reports.some((r) => QUIT_KINDS.has(r.report.kind))
            ? t("status.crashReport.quit")
            : t("status.crashReport.problem")}
        </h2>
        <p className="text-footnote text-muted">{t("status.crashReport.privacy")}</p>
      </div>
      <label className="block space-y-1 text-footnote text-muted">
        <span>{t("status.crashReport.note")}</span>
        <TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={4000}
          className="w-full resize-none text-callout"
        />
      </label>
      <details className="text-footnote text-muted">
        <summary className="cursor-pointer hover:text-ink">{t("status.crashReport.details")}</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control bg-canvas p-2 text-caption text-ink select-text">
          {payload}
        </pre>
      </details>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={dismiss}>
          {t("status.crashReport.dontSend")}
        </Button>
        <Button size="sm" onClick={send}>
          {t("status.crashReport.send")}
        </Button>
      </div>
    </Panel>
  );
}
