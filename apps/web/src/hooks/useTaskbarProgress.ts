import { useEffect } from "react";
import { api } from "../api/client";
import { ignore } from "../lib/ignore";

export type TaskbarState = { status: "none" | "indeterminate" | "normal"; progress?: number };

/** What the taskbar (Windows), dock (macOS) or launcher (Linux) shows for the jobs running now. */
export function taskbarStateFor(jobs: { running: number; progress: number | null }): TaskbarState {
  if (jobs.running === 0) return { status: "none" };
  if (jobs.progress == null) return { status: "indeterminate" };
  return { status: "normal", progress: Math.round(Math.min(1, Math.max(0, jobs.progress)) * 100) };
}

/** Desktop app only: mirrors the background jobs' progress onto the app's taskbar or dock icon. A
 *  server answers 404, which ends the polling. */
export function useTaskbarProgress(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let last = "";
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const [{ getCurrentWindow, ProgressBarStatus }, jobs] = await Promise.all([
          import("@tauri-apps/api/window"),
          api.get("/settings/jobs/progress"),
        ]);
        if (stopped) return;
        const next = taskbarStateFor(jobs);
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          await getCurrentWindow().setProgressBar({
            status:
              ProgressBarStatus[
                next.status === "none" ? "None" : next.status === "normal" ? "Normal" : "Indeterminate"
              ],
            progress: next.progress,
          });
        }
        timer = setTimeout(tick, 2000);
      } catch (err) {
        ignore("Couldn't update the taskbar progress")(err);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [enabled]);
}
