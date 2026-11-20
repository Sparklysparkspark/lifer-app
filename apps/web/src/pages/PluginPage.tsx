// A companion app's screen, full-bleed under the toolbar. Opening the page starts the app once;
// after that a stopped app only restarts when the user asks, so a crashing app can't loop.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import type { PluginEndpoint, PluginStatus } from "@lifer/shared";
import EmptyState from "../components/EmptyState";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";
import { useSidebarLayout } from "../components/AppSidebar";
import {
  PLUGIN_STATUS_POLL_MS,
  pluginStatus,
  setStartedPlugin,
  startedPlugin,
  startPlugin,
  usePlugins,
} from "../lib/plugins";

// "ready" means the layout's frame for this app (components/PluginFrames.tsx) is on screen.
type Session = { phase: "starting" } | { phase: "ready" } | { phase: "stopped"; error: string | null };

function usePluginSession(id: string, present: boolean): { session: Session; start: () => void } {
  const [session, setSession] = useState<Session>(() =>
    startedPlugin(id) ? { phase: "ready" } : { phase: "starting" },
  );
  const starting = useRef(false);

  const ready = useCallback(
    (endpoint: PluginEndpoint) => {
      setStartedPlugin(id, endpoint);
      setSession((was) => (was.phase === "ready" ? was : { phase: "ready" }));
    },
    [id],
  );

  const stopped = useCallback(
    (error: string | null) => {
      setStartedPlugin(id, null);
      setSession({ phase: "stopped", error });
    },
    [id],
  );

  const start = useCallback(() => {
    if (starting.current) return;
    starting.current = true;
    setSession({ phase: "starting" });
    startPlugin(id)
      .then(ready)
      // The shell answers with a plain-words reason as a string.
      .catch((e: unknown) => stopped(typeof e === "string" ? e : null))
      .finally(() => {
        starting.current = false;
      });
  }, [id, ready, stopped]);

  useEffect(() => {
    if (!present) return;
    let live = true;
    const apply = (s: PluginStatus, first: boolean) => {
      if (!live || starting.current) return;
      if (s.state === "running" && s.endpoint) ready(s.endpoint);
      // Joins the start under way (a background open or a relaunch), so the page shows the moment it's up.
      else if (s.state === "starting") {
        setStartedPlugin(id, null);
        start();
      }
      // Only a first-ever open starts by itself; a stopped app waits for the user's Restart.
      else if (first && !s.error && !startedPlugin(id)) start();
      else stopped(s.error);
    };
    const check = (first: boolean) =>
      pluginStatus(id)
        .then((s) => apply(s, first))
        .catch(() => live && !starting.current && stopped(null));
    void check(true);
    const poll = () => document.visibilityState === "visible" && void check(false);
    const timer = window.setInterval(poll, PLUGIN_STATUS_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [id, present, ready, stopped, start]);

  return { session, start };
}

// Keyed by id so each app starts from its own session state.
export default function PluginPage() {
  const { id = "" } = useParams();
  return <PluginView key={id} id={id} />;
}

function PluginView({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sidebarLayout = useSidebarLayout();
  const plugins = usePlugins();
  const plugin = plugins?.find((p) => p.id === id);
  const { session, start } = usePluginSession(id, !!plugin);
  if (plugins === null) return null;

  const name = plugin?.page.label || plugin?.name || id;
  const heading = sidebarLayout ? <h1 className="sr-only">{name}</h1> : <PageHeader title={name} />;
  // The frame itself is the layout's, so the app keeps its state when the user leaves this page.
  if (plugin && session.phase === "ready") return heading;
  return (
    <>
      {heading}
      <main className="relative min-h-0 flex-1 bg-canvas text-ink">
        {!plugin ? (
          <EmptyState
            title={t("plugins.missingTitle")}
            description={t("plugins.missingBody")}
            action={{ label: t("plugins.goHome"), onClick: () => navigate("/") }}
          />
        ) : session.phase === "starting" ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={t("plugins.starting", { name })} />
          </div>
        ) : session.phase === "stopped" ? (
          <EmptyState
            title={t("plugins.stoppedTitle", { name })}
            description={session.error ?? t("plugins.stoppedBody")}
            action={{
              label: session.error ? t("plugins.restart") : t("plugins.start"),
              onClick: start,
            }}
          />
        ) : null}
      </main>
    </>
  );
}
