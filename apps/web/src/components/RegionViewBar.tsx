import { useTranslation } from "react-i18next";
import Button from "./Button";
import Menu, { MenuItems, MenuPanel } from "./Menu";
import { useDropdownMenu } from "../hooks/useDropdownMenu";
import { shortcutLabels } from "../lib/keymap";

const resetShortcut = () => shortcutLabels("zoomFit")[0];

export interface RegionStep {
  id: string;
  name: string;
}

/** The region view's way out: "World / Canada / British Columbia", each step but the last going up
 *  a level, and Reset view (Mod+0) back to the region's framing. When the framing leaves far parts
 *  out (Svalbard for Norway), "Also in Norway" lists them. Nothing shows in the world view. */
export default function RegionViewBar({
  path,
  onPick,
  onReset,
  parts = [],
  partsOf,
  onPart,
}: {
  /** Country first, then province (or a far part); empty in the world view. */
  path: RegionStep[];
  /** null is the world. */
  onPick: (id: string | null) => void;
  onReset: () => void;
  /** The far parts' names, for the region named `partsOf`. */
  parts?: string[];
  partsOf?: string;
  onPart?: (index: number) => void;
}) {
  const { t } = useTranslation();
  const menu = useDropdownMenu();
  if (path.length === 0) return null;
  const steps: Array<RegionStep | null> = [null, ...path.slice(0, -1)];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <nav aria-label={t("mapRegion.pathLabel")} className="flex min-w-0 flex-wrap items-center gap-1 text-callout">
        {steps.map((step) => (
          <span key={step?.id ?? "world"} className="flex min-w-0 items-center gap-1">
            <Button variant="link" onClick={() => onPick(step?.id ?? null)} className="max-w-48 text-link!">
              <span className="truncate">{step?.name ?? t("mapRegion.world")}</span>
            </Button>
            <span aria-hidden="true" className="text-muted">
              /
            </span>
          </span>
        ))}
        <span aria-current="location" className="min-w-0 truncate font-semibold text-ink">
          {path.at(-1)!.name}
        </span>
      </nav>
      <Button
        variant="secondary"
        size="sm"
        onClick={onReset}
        tooltip={{
          label: t("mapRegion.resetView"),
          shortcut: resetShortcut(),
          description: t("mapRegion.resetViewHelp"),
        }}
      >
        {t("mapRegion.resetView")}
      </Button>
      {parts.length > 0 && partsOf && onPart && (
        <Menu
          open={menu.openKey === true}
          onToggle={() => menu.setOpenKey(menu.openKey ? null : true)}
          menuRef={menu.ref}
          className="relative shrink-0"
          trigger={(props) => (
            <Button variant="link" size="sm" className="text-link!" {...props}>
              {t("mapRegion.alsoIn", { region: partsOf })}
            </Button>
          )}
        >
          <MenuPanel className="whitespace-nowrap">
            <MenuItems items={parts.map((name, i) => ({ label: name, onSelect: () => onPart(i) }))} />
          </MenuPanel>
        </Menu>
      )}
    </div>
  );
}
