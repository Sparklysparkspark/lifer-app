import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { createSearchParams, type SetURLSearchParams } from "react-router-dom";
import { api, apiPath, ApiError } from "../../api/client";
import Button from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Modal from "../../components/Modal";
import SearchInput from "../../components/SearchInput";
import { useToast } from "../../hooks/useToast";
import { ignore } from "../../lib/ignore";
import { useApiResource } from "../../lib/resource";
import ProgressiveImg from "../../components/ProgressiveImg";
import { PhotoFilterFields } from "../../components/PhotoFiltersMenu";
import { ALL_PHOTO_FILTER_SECTIONS } from "../../lib/photoGridSections";
import {
  queryFromRules,
  rulesFromQuery,
  rulesQueryParams,
  useRulesSummary,
  type SmartAlbumRules,
} from "../gallery/smartAlbumRules";
import { useGalleryFacets } from "../gallery/useGalleryFacets";
import { useGalleryFilters } from "../gallery/useGalleryFilters";
import { AlbumSuggestionsRow } from "./AlbumSuggestions";
import { suggestionName, type AlbumSuggestion } from "./suggestionName";

// How many of the first matches the preview strip shows.
const PREVIEW_PHOTOS = 8;

// A new smart album starts where the Gallery does: photos only, RAW-only ones included.
const NEW_ALBUM_RULES: SmartAlbumRules = { version: 2, query: { excludeVideo: "1" } };
const NEW_ALBUM_QUERY = rulesQueryParams(NEW_ALBUM_RULES.query).toString();
// Waits for a pause in filter changes, so a run of clicks counts once.
const COUNT_DELAY_MS = 300;

interface Suggestions {
  suggestions: AlbumSuggestion[];
  dismissedCount: number;
  startMatches: { photoCount: number; previewPhotoIds: string[] };
}

// Picks a smart album's rules with the Gallery's own filter controls, counting matches as they
// change. Without albumId it creates the album; with one it saves that album's rules.
export default function SmartAlbumBuilder({
  albumId,
  rules,
  onClose,
  onSaved,
}: {
  albumId?: string;
  rules?: SmartAlbumRules | null;
  onClose: () => void;
  onSaved: (albumId: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  // Only a new album starts from a suggestion.
  const suggestionsRes = useApiResource<Suggestions>(albumId ? null : "/albums/suggestions");
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissedRes = useApiResource<Suggestions>(
    showDismissed && !albumId ? "/albums/suggestions?dismissed=true" : null,
  );
  const suggestions = showDismissed ? (dismissedRes.data?.suggestions ?? []) : (suggestionsRes.data?.suggestions ?? []);
  const [creatingSuggestionId, setCreatingSuggestionId] = useState<string | null>(null);
  const [start, setStart] = useState<AlbumSuggestion | null>(null);
  // Bumped on each Customize, so picking the same suggestion again resets edited filters.
  const [seedKey, setSeedKey] = useState(0);
  const [nextRules, setNextRules] = useState<SmartAlbumRules>(rules ?? NEW_ALBUM_RULES);
  const summary = useRulesSummary(nextRules) ?? "";
  // A suggestion keeps its own name until its rules are changed.
  const keepsSuggestion =
    !!start && JSON.stringify(nextRules) === JSON.stringify(rulesFromQuery(queryFromRules(start.rules)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The count the album would have, from the same Gallery requests it will run.
  const queryString = rulesQueryParams(nextRules.query).toString();
  // Kept with the query it answers, so a changed filter dims the last answer until its own arrives.
  const [counted, setCounted] = useState<{ query: string; count: number; previewIds: string[] } | null>(null);
  // The starting rules' matches come counted with the suggestions, so a new album needn't wait.
  const startMatches = suggestionsRes.data?.startMatches;
  const startAnswer =
    !albumId && startMatches
      ? { query: NEW_ALBUM_QUERY, count: startMatches.photoCount, previewIds: startMatches.previewPhotoIds }
      : null;
  const fromStart = queryString === NEW_ALBUM_QUERY ? startAnswer : null;
  const shown = fromStart ?? counted ?? startAnswer;
  const mustCount = !fromStart;
  const pending = mustCount && counted?.query !== queryString;
  useEffect(() => {
    if (!mustCount) return;
    const controller = new AbortController();
    const query = new URLSearchParams(queryString);
    const preview = (items: Array<{ photoId: string }>) => items.slice(0, PREVIEW_PHOTOS).map((i) => i.photoId);
    const request = () =>
      query.get("q")
        ? api
            .get(apiPath("/gallery/search", {}, query), { signal: controller.signal })
            .then((res) => ({ count: res.items.length, previewIds: preview(res.items) }))
        : api
            .get(apiPath("/gallery", {}, new URLSearchParams([...query, ["limit", String(PREVIEW_PHOTOS)]])), {
              signal: controller.signal,
            })
            .then((res) => ({ count: res.total ?? 0, previewIds: preview(res.items) }));
    const timer = setTimeout(
      () =>
        void request()
          .then((n) => setCounted({ query: queryString, ...n }))
          .catch(ignore("Couldn't count the matching photos")),
      COUNT_DELAY_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [queryString, mustCount]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (albumId) {
        await api.patch(apiPath("/albums/{id}", { id: albumId }), { rules: nextRules });
        onSaved(albumId);
      } else {
        // Named after its rules; the album page opens with that name selected to rename in place.
        const name = keepsSuggestion ? suggestionName(start, t) : summary;
        const created = await api.post("/albums", { name, rules: nextRules });
        onSaved(created.id);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("albums.smart.saveFailed"));
      setSaving(false);
    }
  }

  // The user picked it, so it's made now and opens with its name selected to rename.
  async function createFromSuggestion(s: AlbumSuggestion) {
    setCreatingSuggestionId(s.id);
    try {
      onSaved((await api.post("/albums", { name: suggestionName(s, t), rules: s.rules })).id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t("albums.create.failed"));
      setCreatingSuggestionId(null);
    }
  }

  // While the dismissed ones are shown, the same menu item puts one back.
  async function dismissSuggestion(s: AlbumSuggestion) {
    const list = showDismissed ? dismissedRes : suggestionsRes;
    list.setData((prev) => prev && { ...prev, suggestions: prev.suggestions.filter((x) => x.id !== s.id) });
    try {
      await api.post(
        apiPath(showDismissed ? "/albums/suggestions/{id}/restore" : "/albums/suggestions/{id}/dismiss", { id: s.id }),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : t(showDismissed ? "albums.suggestions.restoreFailed" : "albums.suggestions.dismissFailed"),
      );
    }
    // Brings in the next one past the cap, or puts back one that failed to dismiss; the other
    // list is stale either way.
    void Promise.all([suggestionsRes.reload(), showDismissed ? dismissedRes.reload() : undefined]);
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={albumId ? t("albums.smart.editTitle") : t("albums.smart.newTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            {albumId ? t("albums.smart.saveRules") : t("albums.smart.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-footnote">
        <p className="text-callout text-muted">{t("albums.smart.intro")}</p>
        <MatchPreview count={shown?.count ?? null} photoIds={shown?.previewIds ?? null} pending={pending} />
        {(suggestions.length > 0 || showDismissed || (suggestionsRes.data?.dismissedCount ?? 0) > 0) && (
          <>
            <AlbumSuggestionsRow
              suggestions={suggestions}
              creatingId={creatingSuggestionId}
              onCreate={(s) => void createFromSuggestion(s)}
              onCustomize={(s) => {
                setStart(s);
                setSeedKey((k) => k + 1);
              }}
              onDismiss={(s) => void dismissSuggestion(s)}
              dismissedCount={suggestionsRes.data?.dismissedCount ?? 0}
              showingDismissed={showDismissed}
              onToggleDismissed={() => setShowDismissed((v) => !v)}
            />
            <h3 className="pt-2 text-footnote font-medium text-ink">{t("albums.smart.ownRules")}</h3>
          </>
        )}
        {/* Remounted on a new start, so the filters take its rules as their starting values. */}
        <RuleFields key={seedKey} seed={start?.rules ?? rules ?? NEW_ALBUM_RULES} onChange={setNextRules} />
        <FormMessage error={error} />
      </div>
    </Modal>
  );
}

// The first photos the rules match, with the count. While a change is counted the last answer
// stays, dimmed, and the strip keeps its height so the dialog doesn't jump.
function MatchPreview({
  count,
  photoIds,
  pending,
}: {
  count: number | null;
  photoIds: string[] | null;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`space-y-1.5 transition-opacity ${pending && count != null ? "opacity-60" : ""}`}
      aria-busy={pending}
    >
      <p className="text-callout font-medium text-ink" aria-live="polite">
        {count == null ? t("albums.smart.counting") : t("albums.smart.matches", { count })}
      </p>
      <div className="flex h-14 gap-1 overflow-hidden rounded-control bg-surface-muted">
        {(photoIds ?? []).map((id) => (
          <ProgressiveImg
            key={id}
            thumbSrc={`/api/photos/${id}/thumb`}
            fullSrc={`/api/photos/${id}/thumb`}
            alt=""
            className="h-14 w-14 shrink-0"
          />
        ))}
      </div>
    </div>
  );
}

/** The search and Gallery filter controls for a rule set, reporting each change as rules. */
function RuleFields({ seed, onChange }: { seed: SmartAlbumRules; onChange: (rules: SmartAlbumRules) => void }) {
  const { t } = useTranslation();
  // The filters keep their URL-backed values here instead of in the page's address.
  const [params, setParams] = useState(() => new URLSearchParams());
  const setSearchParams = useCallback<SetURLSearchParams>(
    (next) => setParams((prev) => createSearchParams(typeof next === "function" ? next(prev) : next)),
    [],
  );
  const seedQuery = useMemo(() => queryFromRules(seed), [seed]);
  const filters = useGalleryFilters(params, setSearchParams, seedQuery);
  const facets = useGalleryFacets();
  const tagOptions = useApiResource<{ tags: string[] }>("/captures/tags").data?.tags ?? [];
  const rulesJson = JSON.stringify(rulesFromQuery(filters.query));
  useEffect(() => onChange(JSON.parse(rulesJson) as SmartAlbumRules), [rulesJson, onChange]);

  return (
    <>
      <SearchInput
        value={filters.searchInput}
        onChange={filters.setSearchInput}
        placeholder={t("gallery.toolbar.searchPlaceholder")}
        aria-label={t("gallery.toolbar.searchLabel")}
        size="md"
      />
      <PhotoFilterFields
        filters={filters}
        facets={facets}
        tagOptions={tagOptions}
        sections={ALL_PHOTO_FILTER_SECTIONS}
      />
    </>
  );
}
