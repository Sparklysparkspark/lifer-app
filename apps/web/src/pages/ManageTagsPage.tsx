import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";
import SearchInput from "../components/SearchInput";

interface TagRow {
  tag: string;
  count: number;
}

// Every custom tag across your library, with how many photos carry it — the one place to fix a
// typo everywhere at once (rename) or drop a dud tag entirely (delete), instead of opening every
// photo that has it individually. Both actions hit /captures/tags/rename and /captures/tags
// directly (see captures/routes.ts) rather than looping per-capture PATCHes the way bulk-tagging
// from a selection does, since here the "which captures" set is implicit (every capture with
// this tag) rather than something the caller already has in hand.
export default function ManageTagsPage() {
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingDeleteTag, setConfirmingDeleteTag] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function load() {
    api
      .get<{ tags: TagRow[] }>("/captures/tags/manage")
      .then((res) => setTags(res.tags))
      .catch(() => setError("Couldn't load tags. Try again."));
  }

  useEffect(load, []);

  function startRename(tag: string) {
    setEditingTag(tag);
    setRenameDraft(tag);
    setRenameError(null);
  }

  async function commitRename(from: string) {
    const to = renameDraft.trim();
    if (!to || to === from) {
      setEditingTag(null);
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await api.patch("/captures/tags/rename", { from, to });
      setEditingTag(null);
      load();
    } catch (err) {
      setRenameError(err instanceof ApiError ? err.message : "Couldn't rename that tag.");
    } finally {
      setRenaming(false);
    }
  }

  async function confirmDelete() {
    if (!confirmingDeleteTag) return;
    setDeleting(true);
    try {
      await api.delete("/captures/tags", { tag: confirmingDeleteTag });
      setConfirmingDeleteTag(null);
      load();
    } catch {
      setError("Couldn't delete that tag. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  const visibleTags = (tags ?? []).filter((t) => t.tag.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <div className="min-h-screen bg-canvas">
      <PageHeader sticky title="Manage Tags" backFallbackTo="/settings" backLabel="Settings" />

      <main className="mx-auto max-w-2xl space-y-4 p-6">
        <p className="text-sm text-muted">
          Every custom tag across your photos. Rename one to fix a typo or merge it into another tag — every photo
          carrying it updates at once. Delete one to remove it everywhere.
        </p>

        {tags && tags.length > 0 && (
          <SearchInput value={search} onChange={setSearch} placeholder="Search tags…" className="w-64" />
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!tags && !error && <Spinner />}

        {tags && tags.length === 0 && <p className="text-sm text-muted">You haven't tagged any photos yet.</p>}
        {tags && tags.length > 0 && visibleTags.length === 0 && (
          <p className="text-sm text-muted">No tags match "{search}".</p>
        )}

        {visibleTags.length > 0 && (
          <div className="divide-y divide-line rounded-lg border border-line bg-surface">
            {visibleTags.map((row) => (
              <div key={row.tag} className="flex items-center gap-3 px-4 py-2.5">
                {editingTag === row.tag ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(row.tag);
                        else if (e.key === "Escape") setEditingTag(null);
                      }}
                      className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-accent"
                    />
                    <button
                      onClick={() => commitRename(row.tag)}
                      disabled={renaming}
                      className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
                    >
                      {renaming ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => setEditingTag(null)} className="shrink-0 text-xs text-muted hover:underline">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <Link
                      to={`/gallery?tag=${encodeURIComponent(row.tag)}`}
                      className="min-w-0 flex-1 truncate text-sm text-ink hover:underline"
                    >
                      {row.tag}
                    </Link>
                    <Link
                      to={`/gallery?tag=${encodeURIComponent(row.tag)}`}
                      className="shrink-0 text-xs text-muted hover:underline"
                    >
                      {row.count} photo{row.count === 1 ? "" : "s"}
                    </Link>
                    <button onClick={() => startRename(row.tag)} className="shrink-0 text-xs text-muted hover:underline">
                      Rename
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteTag(row.tag)}
                      className="shrink-0 text-xs text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {renameError && <p className="text-sm text-red-600">{renameError}</p>}
      </main>

      {confirmingDeleteTag && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmingDeleteTag(null)}
        >
          <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-ink">Delete tag "{confirmingDeleteTag}"?</h3>
            <p className="mt-2 text-xs text-muted">
              This removes the tag from every photo that has it. The photos themselves aren't affected — only the tag
              goes away.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmingDeleteTag(null)}
                className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-muted"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete tag"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
