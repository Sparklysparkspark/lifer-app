// The offer page for a suggested app: what it is, who makes it, and Get. Lifer is only the
// launcher: the main process downloads the publisher's own installer, checks its signatures and
// opens it with the system's installer. Leaving this page never loses anything. Once the app is
// installed (its manifest arrives, or a signed copy sits where the publisher installs it), the
// page offers Open instead.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useSidebarLayout } from "../components/AppSidebar";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import FormMessage from "../components/FormMessage";
import PageHeader from "../components/PageHeader";
import ProgressBar from "../components/ProgressBar";
import { appScopeDetail, appScopeLabel } from "../lib/appScopes";
import { useToast } from "../hooks/useToast";
import { priceKeyFor } from "../lib/cullPrice";
import { openExternal } from "../lib/openExternal";
import { platform } from "../lib/platform";
import { pluginPath, usePlugins } from "../lib/plugins";
import {
  SUGGESTED_APPS,
  setShowSuggestedApps,
  cancelInstall,
  detectInstalled,
  grantSuggestedApp,
  installErrorKey,
  installProgress,
  installSuggestedApp,
  installerFor,
  isIntelMac,
  useTargetKey,
  openInstalled,
  useSuggestedApps,
  type InstallProgress,
} from "../lib/suggestedApps";

const POLL_MS = 500;
// A copy installed by the system installer shows up without a reload.
const DETECT_MS = 5_000;
const PRICE_KEYS = {
  gbp: "suggestedApps.cull.priceGbp",
  eur: "suggestedApps.cull.priceEur",
  usd: "suggestedApps.cull.priceUsd",
} as const;
const STEPS = [
  ["downloading", "suggestedApps.stepDownload"],
  ["verifying", "suggestedApps.stepVerify"],
  ["opening", "suggestedApps.stepOpen"],
] as const;
const SYSTEM_NOTE = {
  mac: "suggestedApps.noteMac",
  windows: "suggestedApps.noteWindows",
  other: "suggestedApps.noteLinux",
} as const;

export default function PluginOfferPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const sidebarLayout = useSidebarLayout();
  const target = useTargetKey();
  const offered = useSuggestedApps().find((a) => a.id === id);
  const manifest = usePlugins()?.find((p) => p.id === id);
  // Suggestions hide an installed app, but this page stays to offer Open.
  const app = offered ?? (manifest ? SUGGESTED_APPS.find((a) => a.id === id) : undefined);
  const [installing, setInstalling] = useState(false);
  const [opened, setOpened] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [standalone, setStandalone] = useState<string | null>(null);

  useEffect(() => {
    if (!installing) return;
    let live = true;
    const timer = window.setInterval(() => {
      installProgress(id)
        .then((p) => live && setProgress(p))
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [installing, id]);

  const known = app !== undefined;
  useEffect(() => {
    if (!known || manifest || installing) return;
    let live = true;
    const look = () =>
      detectInstalled(id)
        .then((path) => live && setStandalone(path))
        .catch(() => undefined);
    void look();
    const timer = window.setInterval(look, DETECT_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [known, manifest, installing, id]);

  // Titled by the app's own name, like its toolbar and installed page (lib/appName.ts).
  const name = app?.name ?? "";
  const heading = sidebarLayout ? <h1 className="sr-only">{name}</h1> : <PageHeader title={name} />;
  if (!app)
    return (
      <>
        {heading}
        <EmptyState
          title={t("suggestedApps.missingTitle")}
          description={t("suggestedApps.missingBody")}
          action={{ label: t("plugins.goHome"), onClick: () => navigate("/") }}
        />
      </>
    );

  const installer = installerFor(app, target);
  const pending = installer?.pending === true;

  async function install() {
    if (!app) return;
    setError(null);
    setProgress(null);
    setInstalling(true);
    try {
      // If this fails, the app asks in the usual dialog when it first connects.
      if (app.scopes?.length) await grantSuggestedApp(app).catch(() => undefined);
      await installSuggestedApp(app);
      setOpened(true);
      toast.success(t("suggestedApps.opened", { name: app.name }));
    } catch (err) {
      const key = installErrorKey(err);
      if (key) setError(t(key, { name: app.name }));
    } finally {
      setInstalling(false);
    }
  }

  async function openStandalone() {
    if (!app) return;
    try {
      await openInstalled(app.id);
    } catch (err) {
      setError(t(installErrorKey(err) ?? "suggestedApps.failed", { name: app.name }));
    }
  }

  function hide() {
    // Leave first: with suggestions off this page's app no longer exists.
    navigate("/");
    setShowSuggestedApps(false);
  }

  const stage = progress?.stage ?? "downloading";
  const percent =
    stage === "downloading" && progress && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null;
  const stageIndex = STEPS.findIndex(([s]) => s === stage);
  // The publisher's website is the way whenever Lifer can't install here.
  const website = !installer || error !== null;
  return (
    <>
      {heading}
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-5 py-6 text-ink">
        <h2 className="text-title-3 font-semibold break-words">{app.name}</h2>
        <p className="break-words">{app.description}</p>
        <p className="text-callout text-ink-muted break-words">
          {t("suggestedApps.madeBy", { publisher: app.publisher })}
        </p>
        {app.offer === "cull" && (
          <>
            <ul className="list-disc space-y-1 pl-5 break-words">
              <li>{t("suggestedApps.cull.point1")}</li>
              <li>{t("suggestedApps.cull.point2")}</li>
            </ul>
            {/* Showing it inside Lifer needs the app's hand-off, not built on Windows yet. */}
            <p className="break-words">
              {t(platform === "windows" ? "suggestedApps.cull.modesWindows" : "suggestedApps.cull.modes")}{" "}
              {t("suggestedApps.cull.connect")}
            </p>
            <p className="break-words">{t("suggestedApps.cull.free")}</p>
            <div className="flex flex-col gap-1 break-words">
              <p className="font-semibold">{t("suggestedApps.cull.trial")}</p>
              <p className="text-callout">{t(PRICE_KEYS[priceKeyFor(navigator.language)])}</p>
              <p className="text-callout text-ink-muted">{t("suggestedApps.cull.terms")}</p>
            </div>
          </>
        )}
        {app.pricingText && <p className="text-callout break-words">{app.pricingText}</p>}
        {app.licenseUrl && (
          <div>
            <Button variant="link" onClick={() => openExternal(app.licenseUrl!)}>
              {t("suggestedApps.licence")}
            </Button>
          </div>
        )}
        {manifest ? (
          <>
            <p>{t("suggestedApps.installed", { name: app.name })}</p>
            <div>
              <Button onClick={() => navigate(pluginPath(app.id))}>
                {t("suggestedApps.open", { name: app.name })}
              </Button>
            </div>
          </>
        ) : standalone ? (
          <>
            <p className="break-words">{t("suggestedApps.alreadyInstalled", { name: app.name })}</p>
            <p className="text-footnote text-ink-muted break-all">{standalone}</p>
            <div>
              <Button onClick={() => void openStandalone()}>{t("suggestedApps.open", { name: app.name })}</Button>
            </div>
          </>
        ) : installer ? (
          <>
            {!pending && (
              <p className="text-callout break-words">
                {t("suggestedApps.disclosure", { host: installer.host })}
                {app.offer === "cull" && ` ${t("suggestedApps.cull.counted")}`}
              </p>
            )}
            {!pending && !!app.scopes?.length && (
              <div className="text-callout break-words">
                <p>{t("suggestedApps.connects", { name: app.name })}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {app.scopes.map((s) => (
                    <li key={s}>
                      {appScopeLabel(t, s)}
                      {appScopeDetail(t, s) && (
                        <span className="block text-footnote text-muted">{appScopeDetail(t, s)}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-footnote text-ink-muted">{t("pairing.revokeLater")}</p>
              </div>
            )}
            {installing ? (
              <div className="flex flex-col gap-2">
                <ol className="list-decimal space-y-1 pl-5 text-callout" aria-label={t("suggestedApps.steps")}>
                  {STEPS.map(([s, key], i) => (
                    <li
                      key={s}
                      aria-current={i === stageIndex ? "step" : undefined}
                      className={i === stageIndex ? "font-semibold" : i < stageIndex ? "text-ink-muted" : undefined}
                    >
                      {t(key, { name: app.name })}
                    </li>
                  ))}
                </ol>
                <ProgressBar value={percent} label={t(STEPS[stageIndex][1], { name: app.name })} />
                <div>
                  <Button variant="secondary" onClick={() => void cancelInstall(id)}>
                    {t("suggestedApps.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button disabled={pending} onClick={() => void install()}>
                  {pending
                    ? t("suggestedApps.soon")
                    : app.offer
                      ? t("suggestedApps.cull.start")
                      : t("suggestedApps.install")}
                </Button>
              </div>
            )}
            {opened && !installing && (
              <p className="text-callout break-words">{t("suggestedApps.afterInstall", { name: app.name })}</p>
            )}
            {!pending && <p className="text-footnote text-ink-muted break-words">{t(SYSTEM_NOTE[platform])}</p>}
            {!pending && isIntelMac(target) && (
              <p className="text-footnote text-ink-muted break-words">{t("suggestedApps.noteIntelMac")}</p>
            )}
          </>
        ) : (
          <p className="text-callout">{t("suggestedApps.noInstaller", { name: app.name })}</p>
        )}
        <FormMessage error={error} />
        <div className="flex flex-wrap gap-x-4">
          {website && !manifest && !standalone ? (
            <Button variant="link" onClick={() => openExternal(app.homepage)}>
              {t("suggestedApps.websiteInstead")}
            </Button>
          ) : (
            <Button variant="link" onClick={() => openExternal(app.homepage)}>
              {app.offer ? t("suggestedApps.cull.learnMore") : t("suggestedApps.website")}
            </Button>
          )}
        </div>
        <div className="border-t border-line pt-3">
          <Button variant="link" onClick={hide}>
            {t("suggestedApps.hide")}
          </Button>
          <p className="text-footnote text-ink-muted">{t("suggestedApps.hideHint")}</p>
        </div>
      </main>
    </>
  );
}
