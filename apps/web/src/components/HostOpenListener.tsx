// A connected app running on its own asked Lifer to open it (api plugins/hostPreference.ts, only
// once the person turned "Open inside Lifer" on): bring the window forward and show the app's page.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiPath } from "../api/client";
import { pluginPath, startedPlugin, usePlugins } from "../lib/plugins";
import { tauriCurrentWindow } from "../lib/tauri";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { useLatest } from "../hooks/useLatest";

const POLL_MS = 2000;
// The API gives up at 30 s; starting an app takes a few.
const SHOW_WAIT_MS = 25_000;

/** True once the app's frame is up (PluginFrames mounts it as soon as the app is started). */
async function frameShown(id: string): Promise<boolean> {
  for (let waited = 0; waited < SHOW_WAIT_MS; waited += 250) {
    if (startedPlugin(id)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function bringForward() {
  const w = tauriCurrentWindow();
  if (!w) return;
  // Each step may be refused by the OS; the page still opens.
  await w.show?.().catch(() => {});
  await w.unminimize?.().catch(() => {});
  await w.setFocus?.().catch(() => {});
}

export default function HostOpenListener() {
  const navigate = useNavigate();
  const plugins = usePlugins();
  const live = useLatest({ navigate, plugins });
  const handled = useRef(new Set<string>());
  // A connected server's page in the desktop window has no apps to open.
  const local = useDeploymentMode() === "desktop";

  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    // Keeps polling while hidden: bringing a hidden window forward is the point.
    async function poll() {
      try {
        const { opens } = await api.get("/plugins/v1/host/opens");
        for (const open of opens) {
          if (cancelled || handled.current.has(open.id)) continue;
          handled.current.add(open.id);
          await api.post(apiPath("/plugins/v1/host/opens/{id}/claim", { id: open.id }));
          const plugin = live.current.plugins?.find((p) => p.id === open.pluginId && p.approved);
          let ok = false;
          if (plugin) {
            await bringForward();
            live.current.navigate(pluginPath(plugin.id));
            ok = await frameShown(plugin.id);
          }
          await api.post(apiPath("/plugins/v1/host/opens/{id}", { id: open.id }), { ok });
        }
      } catch {
        // The app's call answers not_ready on its own if this never gets through.
      }
    }
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [live, local]);

  return null;
}
