import { useState } from "react";
import { useTranslation } from "react-i18next";
import Button from "../../components/Button";
import CoverImage from "../../components/CoverImage";
import Menu, { MenuItem, MenuPanel } from "../../components/Menu";
import Panel from "../../components/Panel";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { suggestionName, type AlbumSuggestion } from "./suggestionName";

// A compact card: the first matches as a quad cover, the name and live count, Create, and a menu
// to customize or dismiss it. Create is secondary: the dialog's one primary action is its own.
function SuggestedAlbumCard({
  suggestion,
  creating,
  menuOpen,
  onToggleMenu,
  menuRef,
  onCreate,
  onCustomize,
  onDismiss,
  dismissed,
}: {
  suggestion: AlbumSuggestion;
  creating: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  menuRef: ReturnType<typeof useDropdownMenu<string>>["ref"];
  onCreate: () => void;
  onCustomize: () => void;
  /** For a dismissed suggestion this puts it back instead of dismissing it. */
  onDismiss: () => void;
  dismissed?: boolean;
}) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const name = suggestionName(suggestion, t);
  const slots = suggestion.previewPhotoIds.map((photoId) => ({ photoId, cropX: null, cropY: null, cropSize: null }));
  return (
    <Panel as="section" aria-label={name} className="w-40 shrink-0 snap-start overflow-hidden p-0!">
      <div className="aspect-square bg-surface-muted">
        <CoverImage
          layout="quad"
          coverPhotoUrl={null}
          cropX={null}
          cropY={null}
          cropSize={null}
          quadSlots={slots}
          alt={name}
        />
      </div>
      <div className="space-y-2 p-3">
        <div className="min-w-0">
          <p className="truncate font-medium leading-tight text-ink" title={name}>
            {name}
          </p>
          <p className="text-footnote text-muted">{t("albums.list.photoCount", { count: suggestion.photoCount })}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            loading={creating}
            onClick={onCreate}
            aria-label={t("albums.suggestions.createNamed", { name })}
          >
            {t("albums.suggestions.create")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="w-8 px-0! text-body"
            aria-label={t("ui.moreOptions")}
            tooltip={{ label: t("ui.moreOptions") }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              // Else the page's outside-click handler closes the menu this click opened.
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setAnchor({ x: r.left, y: r.bottom + 4 });
              onToggleMenu();
            }}
          >
            ⋯
          </Button>
          {/* Portaled at the button: the row scrolls sideways and would clip a panel inside it. */}
          {menuOpen && anchor && (
            <Menu open onToggle={onToggleMenu} menuRef={menuRef} anchorPoint={anchor}>
              <MenuPanel className="w-36">
                <MenuItem onSelect={onCustomize}>{t("albums.suggestions.customize")}</MenuItem>
                <MenuItem onSelect={onDismiss}>
                  {t(dismissed ? "albums.suggestions.restore" : "albums.suggestions.dismiss")}
                </MenuItem>
              </MenuPanel>
            </Menu>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** The Suggestions row in New smart album. Renders nothing when there are none. */
export function AlbumSuggestionsRow({
  suggestions,
  creatingId,
  onCreate,
  onCustomize,
  onDismiss,
  dismissedCount,
  showingDismissed,
  onToggleDismissed,
}: {
  suggestions: AlbumSuggestion[];
  creatingId: string | null;
  onCreate: (s: AlbumSuggestion) => void;
  onCustomize: (s: AlbumSuggestion) => void;
  /** Dismisses a suggestion; while the dismissed ones are shown, restores it. */
  onDismiss: (s: AlbumSuggestion) => void;
  /** How many dismissed suggestions there are to show; the toggle appears when there are any. */
  dismissedCount: number;
  showingDismissed: boolean;
  onToggleDismissed: () => void;
}) {
  const { t } = useTranslation();
  const { openKey, setOpenKey, ref } = useDropdownMenu<string>();
  if (suggestions.length === 0 && dismissedCount === 0) return null;
  return (
    <section aria-labelledby="album-suggestions-title">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 id="album-suggestions-title" className="text-callout font-medium text-ink">
          {t("albums.suggestions.title")}
        </h3>
        {dismissedCount > 0 && (
          <Button variant="link" size="sm" onClick={onToggleDismissed} aria-pressed={showingDismissed}>
            {t(showingDismissed ? "albums.suggestions.hideDismissed" : "albums.suggestions.showDismissed")}
          </Button>
        )}
      </div>
      {showingDismissed && suggestions.length === 0 && (
        <p className="text-footnote text-muted">{t("albums.suggestions.noneDismissed")}</p>
      )}
      {/* Scrolls sideways rather than wrapping, so it stays one row at any width. */}
      <div className="flex snap-x gap-item overflow-x-auto pb-1">
        {suggestions.map((s) => (
          <SuggestedAlbumCard
            key={s.id}
            suggestion={s}
            dismissed={showingDismissed}
            creating={creatingId === s.id}
            menuOpen={openKey === s.id}
            onToggleMenu={() => setOpenKey(openKey === s.id ? null : s.id)}
            menuRef={ref}
            onCreate={() => onCreate(s)}
            onCustomize={() => {
              setOpenKey(null);
              onCustomize(s);
            }}
            onDismiss={() => {
              setOpenKey(null);
              onDismiss(s);
            }}
          />
        ))}
      </div>
    </section>
  );
}
