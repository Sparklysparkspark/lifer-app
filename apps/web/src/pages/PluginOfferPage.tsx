// The offer page for a suggested app that isn't installed: what it is, who makes it, what the
// button downloads and from where. Install runs in the background (the main process downloads, checks the
// signature and opens the installer), so leaving this page never loses anything.
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
import { errorMessage } from "../lib/errorMessage";
import { openExternal } from "../lib/openExternal";
import { platform } from "../lib/platform";
import {
  setShowSuggestedApps,
  cancelInstall,
  grantSuggestedApp,
  installProgress,
  installSuggestedApp,
  installerFor,
  useSuggestedApps,
  type InstallProgress,
} from "../lib/suggestedApps";

const POLL_MS = 500;
const PRICE_KEYS = {
  gbp: "suggestedApps.cull.priceGbp",
  eur: "suggestedApps.cull.priceEur",
  usd: "suggestedApps.cull.priceUsd",
} as const;

export default function PluginOfferPage() {
  const { id = "" } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const sidebarLayout = useSidebarLayout();
  const app = useSuggestedApps().find((a) => a.id === id);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const installer = installerFor(app);
  const pending = installer?.pending === true;
  const host = installer && !pending ? new URL(installer.url).hostname : "";

  async function install() {
    if (!app || !installer) return;
    setError(null);
    setProgress(null);
    setInstalling(true);
    try {
      // If this fails, the app asks in the usual dialog when it first connects.
      if (app.scopes?.length) await grantSuggestedApp(app).catch(() => undefined);
      await installSuggestedApp(app, installer);
      toast.success(t("suggestedApps.opened", { name: app.name }));
    } catch (err) {
      // A cancel isn't a failure worth a message.
      if (err !== "Cancelled") setError(errorMessage(err, t("suggestedApps.failed", { name: app.name })));
    } finally {
      setInstalling(false);
    }
  }

  function hide() {
    // Leave first: with suggestions off this page's app no longer exists.
    navigate("/");
    setShowSuggestedApps(false);
  }

  const percent = progress && progress.total > 0 ? (progress.downloaded / progress.total) * 100 : null;
  return (
    <>
      {heading}
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-5 py-6 text-ink">
        <h2 className="text-title-3 font-semibold break-words">{app.name}</h2>
        <p className="break-words">{app.description}</p>
        <p className="text-callout text-ink-muted">{t("suggestedApps.madeBy", { publisher: app.publisher })}</p>
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
        {installer ? (
          <>
            {!pending && (
              <p className="text-callout break-words">
                {t("suggestedApps.disclosure", { host })}
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
                <ProgressBar value={percent} label={t("suggestedApps.downloading", { name: app.name })} />
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
          </>
        ) : (
          <p className="text-callout">{t("suggestedApps.noInstaller", { name: app.name })}</p>
        )}
        <div>
          <Button variant="link" onClick={() => openExternal(app.homepage)}>
            {app.offer ? t("suggestedApps.cull.learnMore") : t("suggestedApps.website")}
          </Button>
        </div>
        <FormMessage error={error} />
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
