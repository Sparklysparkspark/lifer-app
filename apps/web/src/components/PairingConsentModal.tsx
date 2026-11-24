import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { errorMessage } from "../lib/errorMessage";
import { useToast } from "../hooks/useToast";
import { useDeploymentMode } from "../hooks/useDeploymentMode";
import { announceHostPreference } from "../lib/hostPreference";
import { appScopeDetail, appScopeLabel } from "../lib/appScopes";
import Modal from "./Modal";
import Button from "./Button";

type Consent = ApiResponse<"/plugins/v1/consents">["consents"][number];

const POLL_MS = 2000;
// Allow stays off this long after the dialog appears, so a key press or click meant for the app's
// own page (which can ask to pair at any moment) can't answer for the user.
const ARM_MS = 1000;

// A companion app asking to connect (api plugins/routes.ts), or a paired app asking to open inside
// Lifer from now on (hostPreference.ts). Lifer's own window answers, in a dialog above any plugin
// page; the page is another origin and can't reach it.
export default function PairingConsentModal() {
  const { t } = useTranslation();
  const toast = useToast();
  // A connected server's page in the desktop window has no plugins to ask.
  const local = useDeploymentMode() === "desktop";
  const [queue, setQueue] = useState<Consent[]>([]);
  const [armedId, setArmedId] = useState<string | null>(null);
  // Answered here but maybe not yet gone from the next poll.
  const answered = useRef(new Set<string>());
  const current = queue[0];
  const currentId = current?.id;
  const armed = !!currentId && armedId === currentId;

  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    async function poll() {
      if (document.hidden) return;
      try {
        const { consents } = await api.get("/plugins/v1/consents");
        if (!cancelled) setQueue(consents.filter((c) => !answered.current.has(c.id)));
      } catch {
        // The next poll tries again; a missed one only delays the dialog.
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [local]);

  useEffect(() => {
    if (!currentId) return;
    const timer = window.setTimeout(() => setArmedId(currentId), ARM_MS);
    return () => window.clearTimeout(timer);
  }, [currentId]);

  async function answer(allow: boolean) {
    if (!current) return;
    const { id, name, kind, pluginId, openInHost } = current;
    answered.current.add(id);
    setQueue((q) => q.filter((c) => c.id !== id));
    try {
      await api.post(apiPath("/plugins/v1/consents/{id}", { id }), { allow });
      if (allow && kind === "hostPreference") announceHostPreference(pluginId, openInHost ?? true);
    } catch (err) {
      toast.error(errorMessage(err, t("pairing.answerFailed", { name })));
    }
  }

  if (current?.kind === "hostPreference") {
    return (
      <Modal
        open
        onClose={() => void answer(false)}
        dismissOnBackdrop={false}
        title={
          <span className="break-words">
            {t(current.openInHost === false ? "hostPreference.offTitle" : "hostPreference.title", {
              name: current.name,
            })}
          </span>
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => void answer(false)}>
              {t("hostPreference.notNow")}
            </Button>
            <Button disabled={!armed} onClick={() => void answer(true)}>
              {t("hostPreference.yes")}
            </Button>
          </>
        }
      />
    );
  }

  return (
    <Modal
      open={!!current}
      // Closing is an answer too, so the request doesn't come straight back.
      onClose={() => void answer(false)}
      dismissOnBackdrop={false}
      title={current && <span className="break-words">{t("pairing.title", { name: current.name })}</span>}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => void answer(false)}>
            {t("pairing.deny")}
          </Button>
          <Button disabled={!armed} onClick={() => void answer(true)}>
            {t("pairing.allow")}
          </Button>
        </>
      }
    >
      {current && (
        <div className="space-y-3 break-words text-callout">
          {current.code && (
            <div>
              <p className="text-muted">{t("pairing.compareCode", { name: current.name })}</p>
              <p className="mt-1 font-mono text-title2 tracking-widest text-ink">{current.code}</p>
            </div>
          )}
          <div>
            <p className="text-muted">{t("pairing.willBeAbleTo", { name: current.name })}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink">
              {current.scopes.map((s) => (
                <li key={s}>
                  {appScopeLabel(t, s)}
                  {appScopeDetail(t, s) && (
                    <span className="block text-footnote text-muted">{appScopeDetail(t, s)}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
          <p className="text-footnote text-muted">{t("pairing.revokeLater")}</p>
        </div>
      )}
    </Modal>
  );
}
