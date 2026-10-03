import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import PageHeader from "../components/PageHeader";
import { Spinner } from "../components/LoadingScreen";
import SearchInput from "../components/SearchInput";
import EmptyState from "../components/EmptyState";
import Button from "../components/Button";
import ConfirmDialog from "../components/ConfirmDialog";
import FormMessage from "../components/FormMessage";
import { pluralize } from "../lib/pluralize";

interface TagRow {
  tag: string;
  count: number;
}

// Library-wide tag list: rename or delete a tag on every photo that carries it in one request.
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
    <div className="flex-1 bg-canvas">
      <PageHeader sticky title="Manage tags" backFallbackTo="/settings" backLabel="Settings" />

      <main className="mx-auto max-w-2xl space-y-4 p-6">
        <p className="text-sm text-muted">
          Every custom tag across your photos. Rename one to fix a typo or merge it into another tag, and every photo
          carrying it updates at once. Delete one to remove it everywhere.
        </p>

        {tags && tags.length > 0 && (
          <SearchInput value={search} onChange={setSearch} placeholder="Search tags…" className="w-64" />
        )}

        <FormMessage error={error} />
        {!tags && !error && <Spinner />}

        {tags && tags.length === 0 && (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" className="h-6 w-6 text-muted" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M20.59 13.41 11 22.99l-9-9L11 4.4 20.59 13.4Z" />
                <path d="M11 4.41V2h9.59L22 3.41V11" />
                <circle cx="16.5" cy="7.5" r="1" />
              </svg>
            }
            title="No tags yet"
            description="You haven't tagged any photos yet. Add a tag from any photo's menu and it'll show up here."
          />
        )}
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
                    <Button size="sm" className="shrink-0" onClick={() => commitRename(row.tag)} loading={renaming}>
                      {renaming ? "Saving…" : "Save"}
                    </Button>
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
                      {pluralize(row.count, "photo")}
                    </Link>
                    <button onClick={() => startRename(row.tag)} className="shrink-0 text-xs text-muted hover:underline">
                      Rename
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteTag(row.tag)}
                      className="shrink-0 text-xs text-red-600 hover:underline dark:text-red-400"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <FormMessage error={renameError} />
      </main>

      <ConfirmDialog
        open={!!confirmingDeleteTag}
        title={`Delete tag "${confirmingDeleteTag ?? ""}"?`}
        message="This removes the tag from every photo that has it. The photos themselves aren't affected, only the tag goes away."
        confirmLabel="Delete tag"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDeleteTag(null)}
      />
    </div>
  );
}
