import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import Button, { IconButton } from "../../components/Button";
import FormMessage from "../../components/FormMessage";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "../../components/Menu";
import Modal from "../../components/Modal";
import Pill from "../../components/Pill";
import RenameModal from "../../components/RenameModal";
import TextField from "../../components/TextField";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useToast } from "../../hooks/useToast";
import type { GalleryFilters } from "./useGalleryFilters";
import { MAX_PINS, type PinnedFilter, type usePinnedFilters } from "./usePinnedFilters";
import { queryFromRules, rulesFromQuery, useRulesSummary, type SmartAlbumRules } from "./smartAlbumRules";

type Pinned = ReturnType<typeof usePinnedFilters>;

// Chips shown before the rest fold into "More".
const VISIBLE_PINS = 5;

const sameRules = (a: SmartAlbumRules, b: SmartAlbumRules) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const canonical = (r: SmartAlbumRules) =>
  Object.entries(r.query)
    .map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v] as const)
    .sort(([a], [b]) => a.localeCompare(b));

/** One-click chips for the account's pinned filters, under the Gallery heading. */
export function PinnedFilters({
  pinned,
  filters,
  onManage,
}: {
  pinned: Pinned;
  filters: GalleryFilters;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const more = useDropdownMenu<true>();
  if (pinned.pins.length === 0) return null;
  const current = rulesFromQuery(filters.query);
  const apply = (pin: PinnedFilter) => filters.applyQuery(queryFromRules(pin.rules));
  const shown = pinned.pins.slice(0, VISIBLE_PINS);
  const rest = pinned.pins.slice(VISIBLE_PINS);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label={t("gallery.pins.label")}>
      {shown.map((pin) => (
        <Pill
          key={pin.id}
          size="sm"
          active={sameRules(pin.rules, current)}
          onClick={() => apply(pin)}
          className="max-w-56"
        >
          <span className="truncate" title={pin.name}>
            {pin.name}
          </span>
        </Pill>
      ))}
      <Menu
        trigger="toolbar"
        open={more.openKey === true}
        onToggle={() => more.setOpenKey(more.openKey ? null : true)}
        menuRef={more.ref}
        className="relative"
      >
        <MenuPanel className="min-w-44 max-w-72">
          {rest.map((pin) => (
            <MenuItem key={pin.id} onSelect={() => apply(pin)}>
              <span className="block truncate" title={pin.name}>
                {pin.name}
              </span>
            </MenuItem>
          ))}
          {rest.length > 0 && <MenuSeparator />}
          <MenuItem onSelect={onManage}>{t("gallery.pins.manage")}</MenuItem>
        </MenuPanel>
      </Menu>
    </div>
  );
}

/** Names the current filters and pins them. */
export function PinFilterModal({
  pinned,
  filters,
  onClose,
}: {
  pinned: Pinned;
  filters: GalleryFilters;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const rules = rulesFromQuery(filters.query);
  const summary = useRulesSummary(rules) ?? "";
  async function save(name: string) {
    await pinned.add(name.slice(0, 80), rules);
    toast.success(t("gallery.pins.pinned"));
    onClose();
  }
  return (
    <RenameModal
      title={t("gallery.pins.pinTitle")}
      initialName={summary.slice(0, 80)}
      onCancel={onClose}
      onSave={save}
    />
  );
}

/** Rename, reorder, unpin, or turn a pin into a smart album. Each change saves at once. */
export function ManagePinsModal({ pinned, onClose }: { pinned: Pinned; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const { pins } = pinned;

  async function change(next: readonly PinnedFilter[]) {
    setError(null);
    try {
      await pinned.save(next);
    } catch {
      setError(t("gallery.pins.saveFailed"));
    }
  }
  const move = (i: number, by: -1 | 1) => {
    const next = [...pins];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void change(next);
  };
  async function toSmartAlbum(pin: PinnedFilter) {
    try {
      const created = await api.post("/albums", { name: pin.name, rules: pin.rules });
      onClose();
      navigate(`/albums/${created.id}`);
    } catch {
      setError(t("albums.smart.saveFailed"));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("gallery.pins.manageTitle")}
      footer={<Button onClick={onClose}>{t("common.done")}</Button>}
    >
      {pins.length === 0 ? (
        <p className="text-footnote text-muted">{t("gallery.pins.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {pins.map((pin, i) => (
            <li key={pin.id} className="flex items-center gap-1.5">
              <TextField
                defaultValue={pin.name}
                maxLength={80}
                aria-label={t("gallery.pins.nameLabel")}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (!name) e.target.value = pin.name;
                  else if (name !== pin.name) void change(pins.map((p) => (p.id === pin.id ? { ...p, name } : p)));
                }}
                className="min-w-0 flex-1"
              />
              <IconButton
                aria-label={t("gallery.pins.moveUp", { name: pin.name })}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                ↑
              </IconButton>
              <IconButton
                aria-label={t("gallery.pins.moveDown", { name: pin.name })}
                disabled={i === pins.length - 1}
                onClick={() => move(i, 1)}
              >
                ↓
              </IconButton>
              <Button variant="secondary" size="sm" onClick={() => void toSmartAlbum(pin)}>
                {t("albums.smart.saveFromGallery")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void change(pins.filter((p) => p.id !== pin.id))}>
                {t("gallery.pins.unpin")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormMessage error={error} className="mt-2" />
      <p className="mt-3 text-footnote text-muted">{t("gallery.pins.limit", { count: MAX_PINS })}</p>
    </Modal>
  );
}
