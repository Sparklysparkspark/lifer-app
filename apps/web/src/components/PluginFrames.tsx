// Every started companion app's frame, mounted once in the layout and hidden while its page isn't
// on screen, so the app keeps its state between visits. A frame unloads only when its app stops.
// Apps that open in the background start a few seconds after Lifer does, so their page is ready.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import type { PluginEndpoint, PluginSummary } from "@lifer/shared";
import EmptyState from "./EmptyState";
import PluginFrame from "./PluginFrame";
import { Spinner } from "./LoadingScreen";
import { ignore } from "../lib/ignore";
import {
  opensInBackground,
  pluginIdFromPath,
  setStartedPlugin,
  startedPlugin,
  startPlugin,
  useBackgroundPlugins,
  useHiddenPlugins,
  usePlugins,
  useStartedPlugins,
} from "../lib/plugins";

// A frame that hasn't loaded by now is stuck.
const FRAME_SLOW_MS = 20_000;
// Loaders that would flash on a quick load wait this long first.
const LOADER_DELAY_MS = 250;
// Lifer's own start comes first.
const BACKGROUND_DELAY_MS = 3_000;
// Each app gets one background start per session; after that only the user starts it.
const backgroundTried = new Set<string>();

function useBackgroundStart(plugins: PluginSummary[] | null) {
  const { hidden } = useHiddenPlugins();
  const { off } = useBackgroundPlugins();
  useEffect(() => {
    const due = (plugins ?? []).filter(
      (p) => p.approved && !hidden.has(p.id) && opensInBackground(p, off) && !backgroundTried.has(p.id),
    );
    if (due.length === 0) return;
    const timer = window.setTimeout(() => {
      for (const p of due) {
        backgroundTried.add(p.id);
        if (startedPlugin(p.id)) continue;
        startPlugin(p.id, true)
          .then((endpoint) => setStartedPlugin(p.id, endpoint))
          .catch(ignore("Couldn't open a companion app in the background"));
      }
    }, BACKGROUND_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [plugins, hidden, off]);
}

// Shows its children only after a short wait, so a fast load never flashes a spinner.
function Delayed({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShow(true), LOADER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return show ? children : null;
}

// One try at loading the frame; a new key (relaunch, reload) starts it afresh.
function FrameAttempt({
  plugin,
  endpoint,
  name,
  visible,
  onReload,
}: {
  plugin: PluginSummary;
  endpoint: PluginEndpoint;
  name: string;
  visible: boolean;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), FRAME_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <>
      <PluginFrame
        plugin={plugin}
        endpoint={endpoint}
        title={t("plugins.frameTitle", { name })}
        visible={visible}
        onLoad={() => setLoaded(true)}
      />
      {!loaded && (
        <div className="absolute inset-0 bg-canvas">
          {slow ? (
            <EmptyState
              title={t("plugins.slowTitle", { name })}
              description={t("plugins.slowBody")}
              action={{ label: t("plugins.reload"), onClick: onReload }}
            />
          ) : (
            <Delayed>
              <div className="flex h-full items-center justify-center">
                <Spinner label={t("plugins.opening", { name })} />
              </div>
            </Delayed>
          )}
        </div>
      )}
    </>
  );
}

function AppFrame({
  plugin,
  endpoint,
  generation,
  visible,
}: {
  plugin: PluginSummary;
  endpoint: PluginEndpoint;
  generation: number;
  visible: boolean;
}) {
  const [reload, setReload] = useState(0);
  const name = plugin.page.label || plugin.name;
  return (
    // The app can ask for the dark surface; the toolbar and sidebar keep Lifer's theme.
    <div
      hidden={!visible}
      className={`absolute inset-0 bg-canvas text-ink ${plugin.page.surface === "dark" ? "dark" : ""}`}
    >
      <FrameAttempt
        key={`${generation}-${reload}`}
        plugin={plugin}
        endpoint={endpoint}
        name={name}
        visible={visible}
        onReload={() => setReload((n) => n + 1)}
      />
    </div>
  );
}

export default function PluginFrames() {
  const { pathname } = useLocation();
  const plugins = usePlugins();
  const started = useStartedPlugins();
  const active = pluginIdFromPath(pathname);
  useBackgroundStart(plugins);
  const running = (plugins ?? []).filter((p) => started.has(p.id));
  if (running.length === 0) return null;
  const onScreen = running.some((p) => p.id === active);
  return (
    // One element type in both cases: swapping it would remount, and reload, every frame.
    <div role={onScreen ? "main" : undefined} className={onScreen ? "relative min-h-0 flex-1" : "hidden"}>
      {running.map((p) => {
        const s = started.get(p.id)!;
        return (
          <AppFrame key={p.id} plugin={p} endpoint={s.endpoint} generation={s.generation} visible={p.id === active} />
        );
      })}
    </div>
  );
}
