import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { Spinner } from "../components/LoadingScreen";
import PageHeader from "../components/PageHeader";

// Grouped the same way the create form's checkboxes are laid out — one row per resource, a
// Read and/or Write column. Kept in sync with apps/api/src/auth/apiKeyRoutes.ts's own
// API_KEY_SCOPES list (the actual source of truth for what's enforceable).
const SCOPE_GROUPS: Array<{ label: string; read?: string; write?: string }> = [
  { label: "Gallery", read: "gallery.read" },
  { label: "Species", read: "species.read" },
  { label: "Stats", read: "stats.read" },
  { label: "Trips", read: "trips.read" },
  { label: "Albums", read: "album.read", write: "album.write" },
  { label: "Shares", read: "share.read", write: "share.write" },
];

interface ApiKey {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  function load() {
    api.get<{ keys: ApiKey[] }>("/api-keys").then((res) => setKeys(res.keys));
  }

  useEffect(load, []);

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
      setError(err instanceof ApiError ? err.message : "Couldn't create this key");
    } finally {
      setSaving(false);
    }
  }

  async function revoke(id: string) {
    await api.delete(`/api-keys/${id}`);
    load();
  }

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader
        title="API keys"
        backFallbackTo="/settings"
        backLabel="Settings"
        actions={
          <button
            onClick={() => setCreating((c) => !c)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
          >
            {creating ? "Cancel" : "New key"}
          </button>
        }
      />

      <main className="mx-auto max-w-2xl space-y-6 p-6">
        {revealedToken && (
          <div className="rounded-lg border border-accent bg-surface p-4">
            <p className="text-sm font-medium text-ink">Your new API key</p>
            <p className="mt-1 text-xs text-muted">
              Copy it now. You won't be able to see it again. If you lose it, revoke this key and create a new one.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md border border-line bg-surface-muted px-3 py-2 text-xs text-ink">
                {revealedToken}
              </code>
              <button
                onClick={() => navigator.clipboard.writeText(revealedToken)}
                className="rounded-md border border-line px-3 py-2 text-xs hover:bg-surface-muted"
              >
                Copy
              </button>
            </div>
            <button onClick={() => setRevealedToken(null)} className="mt-3 text-xs text-muted underline">
              Done
            </button>
          </div>
        )}

        {creating && (
          <form onSubmit={createKey} className="space-y-4 rounded-lg border border-line bg-surface p-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Home Assistant dashboard"
                autoFocus
                required
                className="w-full rounded-md border border-line px-3 py-2 text-sm"
              />
            </div>
            <div>
              <p className="mb-2 text-sm font-medium text-ink">Permissions</p>
              <div className="space-y-1.5">
                {SCOPE_GROUPS.map((group) => (
                  <div key={group.label} className="flex items-center gap-4 text-sm text-ink">
                    <span className="w-20 shrink-0">{group.label}</span>
                    {group.read && (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={selected.has(group.read)} onChange={() => toggle(group.read!)} />
                        Read
                      </label>
                    )}
                    {group.write && (
                      <label className="flex items-center gap-1.5">
                        <input type="checkbox" checked={selected.has(group.write)} onChange={() => toggle(group.write!)} />
                        Write
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={saving || !name.trim() || selected.size === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
            >
              {saving ? "Creating…" : "Create key"}
            </button>
          </form>
        )}

        {!keys ? (
          <Spinner />
        ) : keys.length === 0 ? (
          <p className="text-muted">No API keys yet.</p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{key.name}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{key.permissions.join(", ")}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {key.lastUsedAt ? `Last used ${new Date(key.lastUsedAt).toLocaleDateString()}` : "Never used"}
                  </p>
                </div>
                <button
                  onClick={() => revoke(key.id)}
                  className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-red-600 hover:bg-surface-muted"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
