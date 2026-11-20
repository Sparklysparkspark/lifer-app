import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "../api/client";
import ManageListPage, { ManageList, RowRenameField } from "../components/ManageListPage";
import { docsUrl } from "../lib/docs";
import ConfirmDialog from "../components/ConfirmDialog";
import FormMessage from "../components/FormMessage";
import { backStateFor } from "../lib/backLabel";

interface TagRow {
  tag: string;
  count: number;
}

// Library-wide tag list: rename or delete a tag on every photo that carries it in one request.
export default function ManageTagsPage() {
  const { t } = useTranslation();
  const title = t("manageTags.title");
  const location = useLocation();
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<TagRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function fetchList() {
    api
      .get("/captures/tags/manage")
      .then((res) => setTags(res.tags))
      .catch(() => setLoadError(true));
  }

  // Retrying clears an earlier error; the first load has none to clear.
  function load() {
    setLoadError(false);
    fetchList();
  }

  useEffect(fetchList, []);

  function startRename(tag: string) {
    setEditingTag(tag);
    setRenameDraft(tag);
  }

  async function commitRename(from: string) {
    const to = renameDraft.trim();
    if (!to || to === from) {
      setEditingTag(null);
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      await api.patch("/captures/tags/rename", { from, to });
      setEditingTag(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("manageTags.renameFailed"));
    } finally {
      setRenaming(false);
    }
  }

  async function confirmDelete() {
    if (!confirmingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await api.delete("/captures/tags", { tag: confirmingDelete.tag });
      setConfirmingDelete(null);
      load();
    } catch {
      setError(t("manageTags.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  const query = search.trim().toLowerCase();
  const visibleTags = (tags ?? []).filter((row) => row.tag.toLowerCase().includes(query));
  const linkState = backStateFor(location, t, title);

  return (
    <>
      <ManageListPage
        title={title}
        backLabel={t("manageTags.backLabel")}
        description={t("manageTags.intro")}
        help={[t("manageTags.help.scope")]}
        docsHref={docsUrl("/settings#library-links")}
        search={{ value: search, onChange: setSearch, placeholder: t("manageTags.searchPlaceholder") }}
        headerExtra={error && <FormMessage error={error} className="mt-3" />}
        loading={!tags}
        error={loadError ? t("manageTags.loadFailed") : null}
        onRetry={load}
        isEmpty={tags?.length === 0}
        empty={{
          icon: (
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20.59 13.41 11 22.99l-9-9L11 4.4 20.59 13.4Z" />
              <path d="M11 4.41V2h9.59L22 3.41V11" />
              <circle cx="16.5" cy="7.5" r="1" />
            </svg>
          ),
          title: t("manageTags.empty.title"),
          description: t("manageTags.empty.description"),
        }}
        noMatch={visibleTags.length === 0 ? t("manageTags.noMatch", { search }) : null}
      >
        <ManageList
          label={title}
          rows={visibleTags.map((row) => ({
            key: row.tag,
            primary: row.tag,
            trailing: t("manageTags.photoCount", { count: row.count }),
            to: `/gallery?tag=${encodeURIComponent(row.tag)}`,
            linkState,
            menu: [
              { label: t("common.rename"), onSelect: () => startRename(row.tag) },
              { label: t("common.delete"), danger: true, onSelect: () => setConfirmingDelete(row) },
            ],
            editor:
              editingTag === row.tag ? (
                <RowRenameField
                  label={t("manageTags.renameLabel", { name: row.tag })}
                  value={renameDraft}
                  onChange={setRenameDraft}
                  onSave={() => void commitRename(row.tag)}
                  onCancel={() => setEditingTag(null)}
                  saving={renaming}
                />
              ) : undefined,
          }))}
        />
      </ManageListPage>

      <ConfirmDialog
        open={!!confirmingDelete}
        title={t("manageTags.deleteConfirm.title", { tag: confirmingDelete?.tag ?? "" })}
        message={t("manageTags.deleteConfirm.message", { count: confirmingDelete?.count ?? 0 })}
        confirmLabel={t("manageTags.deleteConfirm.confirm")}
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmingDelete(null)}
      />
    </>
  );
}
