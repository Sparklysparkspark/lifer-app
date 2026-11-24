import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api, apiPath, type ApiResponse } from "../api/client";
import { SCOPE_GROUPS, keyScopeLabel, type KeyScope as Scope } from "../lib/appScopes";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { docsUrl } from "../lib/docs";
import { errorMessage } from "../lib/errorMessage";
import { formatDate, formatList } from "../lib/format";
import TextField from "../components/TextField";
import Checkbox from "../components/Checkbox";
import Panel from "../components/Panel";

const API_GUIDE_URL = docsUrl("/api/overview");

type ApiKey = ApiResponse<"/api-keys">["keys"][number];
const OWN_PAGE = new Set(["sync", "companion"]);

export default function ApiKeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<Scope>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  function fetchKeys() {
    api
      .get("/api-keys")
      // Linked desktops, phones and connected apps have their own Settings pages.
      .then((res) => setKeys(res.keys.filter((k) => !k.pluginId && !k.permissions.some((p) => OWN_PAGE.has(p)))))
      .catch((err) => setLoadError(errorMessage(err, t("apiKeys.loadFailed"))));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(null);
    fetchKeys();
  }

  // Runs once per language (t is stable until the language changes).
  useEffect(fetchKeys, [t]);

  function toggle(scope: Scope) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post("/api-keys", { name: name.trim(), permissions: [...selected] });
      setRevealedToken(res.token);
      setName("");
      setSelected(new Set());
      setCreating(false);
      load();
    } catch (err) {
      setError(errorMessage(err, t("apiKeys.createFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function revoke(key: ApiKey) {
    const ok = await confirm({
      title: t("apiKeys.revokeConfirm.title", { name: key.name }),
      message: t("apiKeys.revokeConfirm.message"),
      confirmLabel: t("apiKeys.revoke"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(apiPath("/api-keys/{id}", { id: key.id }));
      load();
    } catch (err) {
      toast.error(errorMessage(err, t("apiKeys.revokeFailed")));
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      toast.success(t("apiKeys.copied"));
    } catch {
      toast.error(t("apiKeys.copyFailed"));
    }
  }

  return (
    <div className="flex-1 bg-canvas">
      <PageHeader
        sticky
        title={t("apiKeys.title")}
        backFallbackTo="/settings"
        backLabel={t("apiKeys.backLabel")}
        actions={
          <Button size="sm" variant={creating ? "secondary" : "primary"} onClick={() => setCreating((c) => !c)}>
            {creating ? t("common.cancel") : t("apiKeys.newKey")}
          </Button>
        }
      >
        <p className="text-callout text-muted">
          <Trans
            i18nKey="apiKeys.intro"
            components={{
              guide: (
                <a
                  href={API_GUIDE_URL}
                  // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                />
              ),
              openapi: (
                <a
                  href="/api/openapi.json"
                  // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                />
              ),
            }}
          />
        </p>
      </PageHeader>

      <main className="mx-auto max-w-2xl space-y-section p-page">
        {revealedToken && (
          <div className="rounded-panel border border-accent bg-surface p-panel">
            <p className="text-callout font-semibold text-ink">{t("apiKeys.revealed.title")}</p>
            <p className="mt-1 text-footnote text-muted">{t("apiKeys.revealed.description")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-control border border-line bg-surface-muted px-3 py-2 text-footnote text-ink">
                {revealedToken}
              </code>
              <Button variant="secondary" size="sm" onClick={() => void copyToken(revealedToken)}>
                {t("apiKeys.copy")}
              </Button>
            </div>
            <Button variant="link" size="sm" onClick={() => setRevealedToken(null)} className="mt-3">
              {t("common.done")}
            </Button>
          </div>
        )}

        {creating && (
          <Panel as="form" onSubmit={createKey} className="space-y-item">
            <p className="text-footnote text-muted">
              <Trans
                i18nKey="apiKeys.form.permissionsHint"
                components={{
                  guide: (
                    <a
                      href={API_GUIDE_URL}
                      // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-accent hover:underline"
                    />
                  ),
                }}
              />
            </p>
            <div>
              <label className="mb-1 block text-callout font-medium text-ink">{t("apiKeys.form.name")}</label>
              <TextField
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.form.namePlaceholder")}
                autoFocus
                required
              />
            </div>
            <div>
              <p className="mb-2 text-callout font-medium text-ink">{t("apiKeys.form.permissions")}</p>
              <div className="space-y-1.5">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.labelKey} className="flex items-center gap-4 text-callout text-ink">
                    <span className="w-20 shrink-0">{t(group.labelKey)}</span>
                    {group.read && (
                      <Checkbox checked={selected.has(group.read)} onChange={() => toggle(group.read!)}>
                        {t("apiKeys.form.read")}
                      </Checkbox>
                    )}
                    {group.write && (
                      <Checkbox checked={selected.has(group.write)} onChange={() => toggle(group.write!)}>
                        {t("apiKeys.form.write")}
                      </Checkbox>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <FormMessage error={error} />
            <Button type="submit" disabled={!name.trim() || selected.size === 0} loading={saving}>
              {saving ? t("apiKeys.form.creating") : t("apiKeys.form.create")}
            </Button>
          </Panel>
        )}

        {loadError ? (
          <div className="space-y-2">
            <FormMessage error={loadError} />
            <Button variant="secondary" size="sm" onClick={load}>
              {t("settings.retry")}
            </Button>
          </div>
        ) : !keys ? (
          <Spinner />
        ) : keys.length === 0 ? (
          // Hidden while the new-key form is open: the form is the answer to "no keys yet".
          creating ? null : (
            <>
              <EmptyState
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-6 w-6 text-muted"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="8" cy="15" r="4" />
                    <path d="M10.5 12.5 20 3M17 6l2 2M14 9l2 2" />
                  </svg>
                }
                title={t("apiKeys.empty.title")}
                description={t("apiKeys.empty.description")}
                action={{ label: t("apiKeys.newKey"), onClick: () => setCreating(true) }}
              />
              <p className="text-center text-callout text-muted">
                <Trans
                  i18nKey="apiKeys.empty.guideHint"
                  components={{
                    guide: (
                      <a
                        href={API_GUIDE_URL}
                        // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-accent hover:underline"
                      />
                    ),
                  }}
                />
              </p>
            </>
          )
        ) : (
          <Panel as="ul" grouped>
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-callout font-medium text-ink">{key.name}</p>
                  <p className="mt-0.5 text-footnote text-muted">
                    {formatList(
                      key.permissions.map((p) => keyScopeLabel(t, p)),
                      "unit",
                    )}
                  </p>
                  <p className="mt-0.5 text-footnote text-muted">
                    {key.lastUsedAt
                      ? t("apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })
                      : t("apiKeys.neverUsed")}
                  </p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void revoke(key)} className="shrink-0">
                  {t("apiKeys.revoke")}
                </Button>
              </li>
            ))}
          </Panel>
        )}
      </main>
    </div>
  );
}
