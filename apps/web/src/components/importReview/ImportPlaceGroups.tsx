// The import screen's "Where": photos grouped by outing, each group with a place chip. Lifer
// suggests (the camera's town, a saved place the GPS falls in, the neighbouring group's place) and
// the user decides. Places are staged on the rows here and applied after the import commits.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api, apiPath } from "../../api/client";
import { useDropdownMenu } from "../../hooks/useDropdownMenu";
import { useRegions } from "../../hooks/useRegions";
import type { ChosenPlace } from "../../hooks/usePlaceFiling";
import { formatNumber, formatWallClock } from "../../lib/format";
import { ignore } from "../../lib/ignore";
import Button from "../Button";
import { Chevron } from "../GroupedSpeciesGrid";
import Menu, { MenuItem, MenuPanel, MenuSeparator } from "../Menu";
import Modal from "../Modal";
import Panel from "../Panel";
import PlaceNameInput from "../PlaceNameInput";
import { PlaceChooser } from "../PlaceStep";
import { groupPlace, rowTime, samePlace, type PlaceableRow, type StagedPlace } from "./importGroups";

/** Groups past this many start collapsed, so a 60-outing card still opens on something readable. */
const OPEN_GROUPS = 5;
const THUMBS = 4;

type Row = PlaceableRow & { label?: string };
type LooksLike = ChosenPlace & { geoprivacy: NonNullable<ChosenPlace["geoprivacy"]> };
type Dialog = {
  kind: "place" | "label";
  keys: string[];
  near: { lat: number; lon: number } | null;
  looksLike: LooksLike | null;
  label: string;
};

const REGION = { source: "region", spotId: null, point: null } as const;
const pointKey = (p: { lat: number; lon: number }) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;

export default function ImportPlaceGroups<R extends Row>({
  groups,
  activeKey,
  regionId,
  onPlace,
  onLabel,
  thumb,
  renderRow,
  groupNote,
}: {
  groups: R[][];
  /** The keyboard's row: its group stays open, and it offers a place of its own. */
  activeKey: string | null;
  /** The batch region, for label suggestions. */
  regionId: string | null;
  onPlace: (keys: string[], place: StagedPlace | null) => void;
  onLabel: (keys: string[], label: string) => void;
  /** A small preview for a collapsed group's header, when the browser can show one. */
  thumb: (row: R) => string | null;
  /** `place` goes in the row's status: its own place, when it differs from its group's. */
  renderRow: (row: R, place: ReactNode) => ReactNode;
  /** A line under a group's header, such as the trip it looks part of. */
  groupNote?: (group: R[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const { regions } = useRegions();
  const regionName = (id: string | null) => (id && regions?.find((r) => r.id === id)?.name) || null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const labelId = useId();

  // A saved place each camera point falls inside, looked up on this computer (never online).
  const [looksLike, setLooksLike] = useState<Record<string, LooksLike | null>>({});
  const asked = useRef(new Set<string>());
  const points = groups.flatMap((g) => {
    const gps = g.find((r) => r.gps)?.gps;
    return gps && !groupPlace(g) ? [pointKey(gps)] : [];
  });
  useEffect(() => {
    for (const near of points) {
      if (asked.current.has(near)) continue;
      asked.current.add(near);
      api
        .get(apiPath("/places/locate", {}, { near }))
        .then(({ places }) => {
          const p = places.find((x) => x.kind === "spot" && x.recognised);
          setLooksLike((prev) => ({
            ...prev,
            [near]: p ? { id: p.id, name: p.name, locality: p.locality, geoprivacy: p.geoprivacy ?? "open" } : null,
          }));
        })
        .catch(ignore("Couldn't look for a saved place near the photos"));
    }
  }, [points.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps -- the joined keys are the dependency

  const spot = (p: ChosenPlace): StagedPlace => ({
    source: "spot",
    name: p.name,
    spotId: p.id,
    regionId: null,
    point: null,
  });
  // The place a group stands for: what it was given, else its camera point.
  const placeOf = (g: R[]): StagedPlace | null => {
    const given = groupPlace(g);
    if (given) return given;
    const gps = g.find((r) => r.gps)?.gps;
    if (!gps) return null;
    const name = gps.town
      ? t("import.places.near", { town: gps.town })
      : (regionName(gps.regionId) ?? t("import.places.cameraPoint"));
    return { source: "session", name, spotId: null, regionId: gps.regionId, point: { lat: gps.lat, lon: gps.lon } };
  };
  const time = (r: R) => formatWallClock(rowTime(r), "time");
  const all = groups.flat();
  const keysOf = (rows: R[]) => rows.map((r) => r.key);
  const openDialog = (kind: Dialog["kind"], rows: R[]) => {
    const gps = rows.find((r) => r.gps)?.gps ?? null;
    setDialog({
      kind,
      keys: keysOf(rows),
      near: gps && { lat: gps.lat, lon: gps.lon },
      looksLike: (gps && looksLike[pointKey(gps)]) ?? null,
      label: rows.find((r) => r.label)?.label ?? "",
    });
  };

  return (
    <div className="space-y-item">
      {groups.length > 1 && (
        <div className="flex justify-end">
          <PlaceMenu
            trigger={t("import.places.allPhotos")}
            onChoose={() => openDialog("place", all)}
            onLabel={() => openDialog("label", all)}
            onRemove={all.some((r) => r.place) ? () => onPlace(keysOf(all), null) : undefined}
          />
        </div>
      )}
      {groups.map((g, i) => {
        const key = g[0].key;
        const given = groupPlace(g);
        const gpsCount = g.filter((r) => r.gps).length;
        const camera = !given && gpsCount === g.length ? placeOf(g) : null;
        const prev = groups[i - 1];
        const prevPlace = prev ? placeOf(prev) : null;
        // Offered in one click on the header for a group shot the same day with no GPS (never automatic).
        const sameDay =
          !given &&
          gpsCount === 0 &&
          prev &&
          prevPlace &&
          formatWallClock(rowTime(prev[0])) === formatWallClock(rowTime(g[0]));
        const gps = g.find((r) => r.gps)?.gps;
        const offer = !given && gps ? looksLike[pointKey(gps)] : null;
        const label = g.find((r) => r.label)?.label;
        const open = i < OPEN_GROUPS || expanded.has(key) || g.some((r) => r.key === activeKey);
        const first = g[0];
        const last = g[g.length - 1];
        const chip = given
          ? given.name
          : camera
            ? t("import.places.fromCamera", { place: camera.name })
            : gpsCount > 0
              ? t("import.places.mixed", {
                  withGps: formatNumber(gpsCount),
                  without: formatNumber(g.length - gpsCount),
                })
              : t("import.places.setPlace");
        return (
          <section key={key} aria-label={t("import.places.groupLabel", { time: time(first) })}>
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* raw-control: the group's heading is its disclosure, as in the species grids. */}
              <button
                type="button"
                aria-expanded={open}
                onClick={() =>
                  setExpanded((prevSet) => {
                    const next = new Set(prevSet);
                    if (open) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                className="flex min-w-0 items-center gap-2 text-left text-callout font-medium text-ink hover:underline"
              >
                <Chevron open={open} />
                {!open &&
                  g.slice(0, THUMBS).map((r) => {
                    const src = thumb(r);
                    return src ? (
                      <img key={r.key} src={src} alt="" className="h-8 w-8 shrink-0 rounded-badge object-cover" />
                    ) : null;
                  })}
                <span className="min-w-0 break-words">
                  {t("import.places.groupTitle", {
                    count: g.length,
                    formatted: formatNumber(g.length),
                    date: formatWallClock(rowTime(first), "monthDay"),
                    span:
                      time(first) === time(last)
                        ? time(first)
                        : t("import.places.timeSpan", { from: time(first), to: time(last) }),
                  })}
                </span>
              </button>
              <PlaceMenu
                trigger={label ? `${chip} · ${label}` : chip}
                onChoose={() => openDialog("place", g)}
                onSame={
                  prev && prevPlace ? { time: time(prev[0]), pick: () => onPlace(keysOf(g), prevPlace) } : undefined
                }
                onLabel={() => openDialog("label", g)}
                onRemove={g.some((r) => r.place) ? () => onPlace(keysOf(g), null) : undefined}
              />
              {offer && (
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-callout">
                  <span className="min-w-0 break-words text-ink">{t("sendPlace.looksLike", { name: offer.name })}</span>
                  <Button variant="secondary" size="sm" onClick={() => onPlace(keysOf(g), spot(offer))}>
                    {t("sendPlace.useIt")}
                  </Button>
                </span>
              )}
              {sameDay && (
                <Button variant="secondary" size="sm" onClick={() => onPlace(keysOf(g), prevPlace)}>
                  {t("import.places.sameAs", { time: time(prev[0]) })}
                </Button>
              )}
            </div>
            {groupNote?.(g)}
            {open && (
              <Panel grouped>
                {g.map((r) =>
                  renderRow(
                    r,
                    !samePlace(r.place, given) || r.key === activeKey ? (
                      <Button variant="link" size="sm" onClick={() => openDialog("place", [r])}>
                        {r.place && !samePlace(r.place, given) ? r.place.name : t("import.places.photoPlace")}
                      </Button>
                    ) : null,
                  ),
                )}
              </Panel>
            )}
          </section>
        );
      })}

      {dialog?.kind === "place" && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={t("import.places.dialogTitle", {
            count: dialog.keys.length,
            formatted: formatNumber(dialog.keys.length),
          })}
          footer={
            <Button variant="secondary" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </Button>
          }
        >
          <PlaceChooser
            near={dialog.near}
            looksLike={dialog.looksLike}
            autoFocus
            onChoose={(p) => {
              onPlace(dialog.keys, spot(p));
              setDialog(null);
            }}
            onRegion={(r) => {
              onPlace(dialog.keys, { ...REGION, name: r.name, regionId: r.id });
              setDialog(null);
            }}
          />
        </Modal>
      )}
      {dialog?.kind === "label" && (
        <Modal
          open
          onClose={() => setDialog(null)}
          title={t("import.places.labelTitle", {
            count: dialog.keys.length,
            formatted: formatNumber(dialog.keys.length),
          })}
          onSubmit={() => {
            onLabel(dialog.keys, dialog.label.trim());
            setDialog(null);
          }}
          footer={
            <>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit">{t("common.save")}</Button>
            </>
          }
        >
          <label htmlFor={labelId} className="sr-only">
            {t("import.places.label")}
          </label>
          <PlaceNameInput
            id={labelId}
            value={dialog.label}
            onChange={(label) => setDialog({ ...dialog, label })}
            regionId={regionId}
            autoFocus
          />
        </Modal>
      )}
    </div>
  );
}

/** The chip: what the group's place is, opening the ways to set it. */
function PlaceMenu({
  trigger,
  onChoose,
  onSame,
  onLabel,
  onRemove,
}: {
  trigger: string;
  onChoose: () => void;
  onSame?: { time: string; pick: () => void };
  onLabel: () => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const { openKey, setOpenKey, ref } = useDropdownMenu<true>();
  const open = openKey === true;
  return (
    <Menu
      open={open}
      onToggle={() => setOpenKey(open ? null : true)}
      menuRef={ref}
      className="relative min-w-0"
      trigger={(props) => (
        <Button
          {...props}
          variant="secondary"
          size="sm"
          className="h-auto! min-h-8 max-w-full whitespace-normal! text-left"
        >
          <span className="min-w-0 break-words">{trigger}</span>
        </Button>
      )}
    >
      <MenuPanel align="left" className="mt-1 w-64">
        <MenuItem onSelect={onChoose}>{t("import.places.choose")}</MenuItem>
        {onSame && <MenuItem onSelect={onSame.pick}>{t("import.places.sameAs", { time: onSame.time })}</MenuItem>}
        <MenuItem onSelect={onLabel}>{t("import.places.label")}</MenuItem>
        {onRemove && (
          <>
            <MenuSeparator />
            <MenuItem onSelect={onRemove}>{t("import.places.remove")}</MenuItem>
          </>
        )}
      </MenuPanel>
    </Menu>
  );
}
