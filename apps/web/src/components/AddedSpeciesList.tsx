// Species you added from iNaturalist (one at a time or from a pasted list), as rows the
// Downloaded list shows under their country next to its downloaded groups ("Insects" under
// Canada). Removing one frees the space their photos take; they don't come back from the
// region picker, only by adding them again.
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { otherTaxaGroupLabel } from "@lifer/shared";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useApiRoute } from "../lib/resource";
import { useConfirm } from "../hooks/useConfirm";
import { useToast } from "../hooks/useToast";
import { errorMessage } from "../lib/errorMessage";
import { formatBytes } from "../lib/format";
import Button from "./Button";

type Group = ApiResponse<"/species/other-taxa/added">["groups"][number];

export interface AddedSpeciesRow {
  country: string;
  /** The group's name, for its checkbox. */
  label: string;
  key: string;
  bytes: number;
  /** false when you have photos of all of them, so nothing would go. */
  removable: boolean;
  photographedCount: number;
  removableCount: number;
  /** Removes the group without asking or reloading; resolves to the species removed. */
  removeQuietly: () => Promise<number>;
  reload: () => Promise<unknown>;
  /** The row, with the list's selection checkbox in the packs' checkbox column. */
  row: (checkbox: ReactNode) => ReactNode;
}

export function useAddedSpeciesRows(namingStyles: string[]): AddedSpeciesRow[] {
  const { data, reload } = useApiRoute(apiPath("/species/other-taxa/added", {}));
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);

  const keyOf = (g: Group) => `${g.country}|${g.iconicTaxon ?? ""}`;
  const groupName = (g: Group) =>
    g.iconicTaxon ? otherTaxaGroupLabel(g.iconicTaxon, namingStyles) : t("addedSpecies.otherSpecies");

  async function removeQuietly(g: Group) {
    const { removed } = await api.post("/species/other-taxa/added/remove", {
      country: g.country,
      iconicTaxon: g.iconicTaxon,
    });
    return removed;
  }

  async function remove(g: Group) {
    const removable = g.speciesCount - g.photographedCount;
    const ok = await confirm({
      title: t("addedSpecies.removeConfirm.title", { group: groupName(g), country: g.country }),
      message: `${
        g.bytes > 0
          ? t("addedSpecies.removeConfirm.bodyFrees", {
              count: removable,
              size: formatBytes(g.bytes),
              country: g.country,
            })
          : t("addedSpecies.removeConfirm.body", { count: removable, country: g.country })
      }${g.photographedCount > 0 ? ` ${t("addedSpecies.removeConfirm.stays", { count: g.photographedCount })}` : ""}`,
      confirmLabel: t("addedSpecies.remove"),
      danger: true,
    });
    if (!ok) return;
    setRemoving(keyOf(g));
    try {
      const removed = await removeQuietly(g);
      toast.success(t("addedSpecies.removed", { count: removed }));
      await reload();
    } catch (err) {
      toast.error(errorMessage(err, t("addedSpecies.removeFailed")));
    } finally {
      setRemoving(null);
    }
  }

  return (data?.groups ?? []).map((g) => {
    const allPhotographed = g.speciesCount === g.photographedCount;
    return {
      country: g.country,
      label: groupName(g),
      key: keyOf(g),
      bytes: g.bytes,
      removable: !allPhotographed,
      photographedCount: g.photographedCount,
      removableCount: g.speciesCount - g.photographedCount,
      removeQuietly: () => removeQuietly(g),
      reload,
      row: (checkbox: ReactNode) => (
        <div className="flex items-center gap-2 text-callout">
          {checkbox}
          <span className="flex-1 text-ink">
            {groupName(g)}
            <span className="ml-2 text-footnote text-muted" title={t("addedSpecies.addedByYouTitle")}>
              {t("addedSpecies.addedByYou", { count: g.speciesCount })}
            </span>
          </span>
          <span className="text-footnote text-muted">{formatBytes(g.bytes)}</span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void remove(g)}
            loading={removing === keyOf(g)}
            disabled={removing !== null || allPhotographed}
            tooltip={allPhotographed ? { label: t("addedSpecies.allPhotographed") } : undefined}
          >
            {t("addedSpecies.remove")}
          </Button>
        </div>
      ),
    };
  });
}
