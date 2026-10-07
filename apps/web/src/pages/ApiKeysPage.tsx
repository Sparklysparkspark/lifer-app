import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../api/client";
import Button from "../components/Button";
import FormMessage from "../components/FormMessage";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";
import EmptyState from "../components/EmptyState";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { docsUrl } from "../lib/docs";
import { errorMessage } from "../lib/errorMessage";
import { formatDate } from "../lib/format";

const API_GUIDE_URL = docsUrl("/api/overview");

// One row per resource with Read/Write columns. Keep in sync with API_KEY_SCOPES in
// apps/api/src/auth/apiKeyRoutes.ts, the source of truth.
const SCOPE_GROUPS: Array<{ labelKey: string; read?: string; write?: string }> = [
  { labelKey: "apiKeys.scopes.gallery", read: "gallery.read" },
  { labelKey: "apiKeys.scopes.species", read: "species.read" },
  { labelKey: "apiKeys.scopes.stats", read: "stats.read" },
  { labelKey: "apiKeys.scopes.trips", read: "trips.read" },
  { labelKey: "apiKeys.scopes.albums", read: "album.read", write: "album.write" },
  { labelKey: "apiKeys.scopes.shares", read: "share.read", write: "share.write" },
  // Integrations (see the API guide): read = photo feed + image files; write = imports + photo edits.
  { labelKey: "apiKeys.scopes.photos", read: "photos.read", write: "photos.write" },
  // write = adding species to region checklists yourself.
  { labelKey: "apiKeys.scopes.lifeList", read: "collection.read", write: "collection.write" },
];

interface ApiKey {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  function fetchKeys() {
    api
      .get<{ keys: ApiKey[] }>("/api-keys")
      .then((res) => setKeys(res.keys))
      .catch((err) => setLoadError(errorMessage(err, t("apiKeys.loadFailed"))));
  }

  // Later reloads clear an earlier error while they retry; the first load has none to clear.
  function load() {
    setLoadError(null);
    fetchKeys();
  }

  // Runs once per language (t is stable until the language changes).
  useEffect(fetchKeys, [t]);

  function toggle(scope: string) {
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
      const res = await api.post<{ token: string }>("/api-keys", { name: name.trim(), permissions: [...selected] });
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
      await api.delete(`/api-keys/${key.id}`);
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
          <Button size="sm" onClick={() => setCreating((c) => !c)}>
            {creating ? t("common.cancel") : t("apiKeys.newKey")}
          </Button>
        }
      >
        <p className="text-sm text-muted">
          <Trans
            i18nKey="apiKeys.intro"
            components={{
              guide: (
                <a
                  href={API_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                />
              ),
              openapi: (
                <a
                  href="/api/openapi.json"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                />
              ),
            }}
          />
        </p>
      </PageHeader>

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {revealedToken && (
          <div className="rounded-lg border border-accent bg-surface p-4">
            <p className="text-sm font-medium text-ink">{t("apiKeys.revealed.title")}</p>
            <p className="mt-1 text-xs text-muted">{t("apiKeys.revealed.description")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md border border-line bg-surface-muted px-3 py-2 text-xs text-ink">
                {revealedToken}
              </code>
              <Button variant="secondary" size="sm" onClick={() => void copyToken(revealedToken)}>
                {t("apiKeys.copy")}
              </Button>
            </div>
            <button onClick={() => setRevealedToken(null)} className="mt-3 text-xs text-muted underline">
              {t("common.done")}
            </button>
          </div>
        )}

        {creating && (
          <form onSubmit={createKey} className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <p className="text-xs text-muted">
              <Trans
                i18nKey="apiKeys.form.permissionsHint"
                components={{
                  guide: (
                    <a
                      href={API_GUIDE_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-accent hover:underline"
                    />
                  ),
                }}
              />
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">{t("apiKeys.form.name")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiKeys.form.namePlaceholder")}
                autoFocus
                required
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-ink">{t("apiKeys.form.permissions")}</p>
              <div className="space-y-1.5">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.labelKey} className="flex items-center gap-4 text-sm text-ink">
                    <span className="w-20 shrink-0">{t(group.labelKey)}</span>
                    {group.read && (
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={selected.has(group.read)}
                          onChange={() => toggle(group.read!)}
                        />
                        {t("apiKeys.form.read")}
                      </label>
                    )}
                    {group.write && (
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={selected.has(group.write)}
                          onChange={() => toggle(group.write!)}
                        />
                        {t("apiKeys.form.write")}
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <FormMessage error={error} />
            <Button type="submit" disabled={!name.trim() || selected.size === 0} loading={saving}>
              {saving ? t("apiKeys.form.creating") : t("apiKeys.form.create")}
            </Button>
          </form>
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
              <p className="text-center text-sm text-muted">
                <Trans
                  i18nKey="apiKeys.empty.guideHint"
                  components={{
                    guide: (
                      <a
                        href={API_GUIDE_URL}
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
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{key.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{key.permissions.join(", ")}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {key.lastUsedAt
                      ? t("apiKeys.lastUsed", { date: formatDate(key.lastUsedAt) })
                      : t("apiKeys.neverUsed")}
                  </p>
                </div>
                <button
                  onClick={() => void revoke(key)}
                  className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-rose-700 hover:bg-surface-muted dark:text-rose-400"
                >
                  {t("apiKeys.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
